import { tool } from 'ai'
import { eq } from 'drizzle-orm'
import * as z from 'zod'
import { getChart } from '../charts.ts'
import * as s from '../db/schema.ts'
import type { ResultColumn } from '../db/types.ts'
import { compileBase, compileChart, type QueryDefinition } from '../query/compile.ts'
import type { Dialect } from '../query/dialect.ts'
import type { Database } from '../runs.ts'
import { describeQuery, type Explorer } from '../snowflake/catalog.ts'
import { SnowflakeError } from '../snowflake/client.ts'
import {
  aggregateColumns,
  chartFields,
  chartFilter,
  chartSpec,
  dimension,
  drillSpec,
  measure,
  orderBy,
  predicateColumns,
  scalarColumns,
} from './shapes.ts'

/**
 * The tools the AI builds a chart with. They are bound to one chart and its
 * data source; nothing the model passes can reach another.
 *
 * A tool reports a mistake the model can fix (bad SQL, an unknown column) as
 * `{ error }` so the model reads it and tries again. Anything else throws.
 */

export type ToolContext = {
  db: Database
  dialect: Dialect
  explorer: Explorer
  chartId: string
}

/** Rows the AI sees when it samples data. */
const SAMPLE_ROWS = 20
/** Longest cell value the AI sees; longer ones are cut. */
const SAMPLE_CELL_CHARS = 200

/** A mistake in what the model asked for, worded for the model. */
class Invalid extends Error {}

/** Turns the model's own mistakes into a result it can read. */
async function attempt<T extends object>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  } catch (error) {
    // 422 = Snowflake rejected the statement itself.
    if (error instanceof Invalid || (error instanceof SnowflakeError && error.status === 422)) return { error: error.message }
    throw error
  }
}

const missing = (wanted: Iterable<string>, columns: ResultColumn[]) => {
  const names = new Set(columns.map((c) => c.name))
  return [...new Set(wanted)].filter((name) => !names.has(name))
}

const quote = (names: string[]) => names.map((n) => `"${n}"`).join(', ')

/**
 * Checks a query definition against the warehouse and returns the columns of
 * its base SQL and of its aggregated result. Nothing is read: both statements
 * are only described.
 */
export async function checkQuery(
  explorer: Explorer,
  dialect: Dialect,
  q: QueryDefinition,
): Promise<{ baseColumns: ResultColumn[]; resultColumns: ResultColumn[] }> {
  const baseColumns = await describeQuery(explorer, compileBase(q, dialect))
  const available = `The base SQL returns: ${quote(baseColumns.map((c) => c.name))}`

  const seen = new Set<string>()
  for (const { name } of baseColumns) {
    // The frozen base rows are read back by column name.
    if (seen.has(name)) throw new Invalid(`The base SQL returns two columns named "${name}"; alias one of them`)
    seen.add(name)
  }

  if (q.dimensions.length === 0 && q.measures.length === 0) {
    if (q.drill) throw new Invalid('A chart without dimensions cannot be drilled into')
    if (q.filters.length > 0) throw new Invalid('Filters need dimensions or measures; a chart of plain SQL cannot be filtered')
    if (q.orderBy.length > 0 || q.limit != null) {
      throw new Invalid('orderBy and limit apply to the aggregated rows; without dimensions or measures, put them in the SQL')
    }
    return { baseColumns, resultColumns: baseColumns }
  }

  const outputs = [...q.dimensions, ...q.measures].map((o) => o.name)
  const duplicate = outputs.find((name, i) => outputs.indexOf(name) !== i)
  if (duplicate) throw new Invalid(`Two dimensions or measures are named "${duplicate}"`)

  const read = new Set<string>()
  for (const d of q.dimensions) scalarColumns(d.expr, read)
  for (const m of q.measures) aggregateColumns(m.expr, read)
  const unknown = missing(read, baseColumns)
  if (unknown.length > 0) throw new Invalid(`Unknown column in an expression: ${quote(unknown)}. ${available}`)

  const unsortable = q.orderBy.map((o) => o.field).filter((field) => !outputs.includes(field))
  if (unsortable.length > 0) throw new Invalid(`orderBy must name a dimension or measure, not ${quote(unsortable)}`)

  if (q.drill) {
    if (q.dimensions.length === 0) throw new Invalid('A drillable chart needs at least one dimension')
    const { rowKey, columns = [], orderBy } = q.drill
    const unknown = missing([...rowKey, ...columns, ...orderBy.map((o) => o.field)], baseColumns)
    if (unknown.length > 0) throw new Invalid(`Unknown column in drill: ${quote(unknown)}. ${available}`)
  }

  const filterNames = q.filters.map((f) => f.name)
  const repeated = filterNames.find((name, i) => filterNames.indexOf(name) !== i)
  if (repeated) throw new Invalid(`Two filters are named "${repeated}"`)
  for (const filter of q.filters) {
    const keys = filter.options.map((o) => o.key)
    const twice = keys.find((key, i) => keys.indexOf(key) !== i)
    if (twice) throw new Invalid(`Filter "${filter.name}" has two options with the key "${twice}"`)
    const absent = (filter.default ?? []).filter((key) => !keys.includes(key))
    if (absent.length > 0) throw new Invalid(`The default of filter "${filter.name}" names options it does not have: ${quote(absent)}`)
    if (!filter.multi && (filter.default ?? []).length > 1) {
      throw new Invalid(`Filter "${filter.name}" takes one option, so its default can name only one; set multi to allow several`)
    }
    const read = new Set<string>()
    for (const option of filter.options) predicateColumns(option.where, read)
    const unknown = missing(read, baseColumns)
    if (unknown.length > 0) throw new Invalid(`Unknown column in filter "${filter.name}": ${quote(unknown)}. ${available}`)
  }

  let chartSql: string
  let filteredSql: string | null
  try {
    chartSql = compileChart(q, dialect)
    const every = q.filters.flatMap((f) => f.options.map((o) => o.where))
    filteredSql = every.length > 0 ? compileBase(q, dialect, every) : null
  } catch (error) {
    throw new Invalid(error instanceof Error ? error.message : String(error))
  }
  // Describing every option at once catches type errors in any of them, e.g. comparing a date with a number.
  if (filteredSql) await describeQuery(explorer, filteredSql)
  // Describing the aggregation catches type errors, e.g. summing a string.
  return { baseColumns, resultColumns: await describeQuery(explorer, chartSql) }
}

const clip = (value: unknown) =>
  typeof value === 'string' && value.length > SAMPLE_CELL_CHARS ? `${value.slice(0, SAMPLE_CELL_CHARS)}…` : value

export function chartTools({ db, dialect, explorer, chartId }: ToolContext) {
  return {
    list_tables: tool({
      description:
        "List the tables and views in the data source's database, with row counts and comments. Start here to find what data exists.",
      inputSchema: z.object({
        schema: z.string().optional().describe('Only this schema, named exactly as Snowflake stores it. Omit for all schemas.'),
      }),
      execute: ({ schema }) => attempt(async () => ({ tables: await explorer.listTables(schema) })),
    }),

    describe_tables: tool({
      description: 'Columns of the given tables: name, type, nullability and comment. Call it once with every table you are considering.',
      inputSchema: z.object({
        tables: z
          .array(z.object({ schema: z.string(), name: z.string() }))
          .min(1)
          .max(50)
          .describe('Schema and table names exactly as list_tables returned them'),
      }),
      execute: ({ tables }) => attempt(async () => ({ tables: await explorer.describeTables(tables) })),
    }),

    sample_rows: tool({
      description: `Run a SELECT and see its first ${SAMPLE_ROWS} rows. Use it to learn what values columns hold (status codes, date ranges, units) before you rely on them. Aggregate in the SQL when you need distinct values or ranges rather than raw rows.`,
      inputSchema: z.object({ sql: z.string().describe('One Snowflake SELECT statement') }),
      execute: ({ sql }) =>
        attempt(async () => {
          // Wrapped as a subquery, so a statement that is not a SELECT fails to compile. (`sample` is reserved in Snowflake.)
          const result = await explorer.execute(`select * from (${sql.trim().replace(/;+$/, '')}) as sampled limit ${SAMPLE_ROWS}`)
          return {
            columns: result.columns.map(({ name, type }) => ({ name, type })),
            rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)]))),
          }
        }),
    }),

    get_chart: tool({
      description:
        'The chart as it is stored now: its title, query and spec. The query and spec are null if nothing has been built yet. Call it before changing a chart you did not build earlier in this conversation.',
      inputSchema: z.object({}),
      execute: async () => {
        const { title, description, query, spec } = await getChart({ db }, chartId)
        return { title, description, query, spec }
      },
    }),

    // Optional fields also accept null, which is how get_chart reports them: the model often sends back what it read.
    save_chart: tool({
      description:
        'Save the chart, replacing what was stored: title, query and spec together. The query is checked against Snowflake and the spec against the query\'s result columns; nothing is saved if either is invalid. Returns the exact column names of the base SQL and of the result.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).nullish().describe('The question this chart answers'),
        query: z.object({
          sql: z
            .string()
            .min(1)
            .describe(
              'Base SQL: one Snowflake SELECT returning one row per item, not aggregated. Joins and fixed filters belong here; leave in every row a viewer filter may choose.',
            ),
          dimensions: z.array(dimension).default([]).describe('What the base rows are grouped by'),
          measures: z.array(measure).default([]).describe('Values computed per group'),
          orderBy: z.array(orderBy).default([]).describe('Sort of the aggregated rows, by dimension or measure name'),
          limit: z.int().positive().max(5000).nullish().describe('Keep only the first N aggregated rows'),
          filters: z
            .array(chartFilter)
            .max(6)
            .default([])
            .describe('Controls the viewer narrows the chart with by picking from options you define. Omit if none are wanted.'),
          drill: drillSpec.nullish().describe('The item list a user sees after clicking a data point. Omit if the rows are not worth listing.'),
        }),
        spec: chartSpec.describe(
          'How the result rows are drawn. Field names are result column names: dimension and measure names as you wrote them, or the columns of the SQL when there are none.',
        ),
      }),
      execute: ({ title, description, query, spec }) =>
        attempt(async () => {
          const definition = { ...query, limit: query.limit ?? null, drill: query.drill ?? null, filters: query.filters ?? [] }
          const { baseColumns, resultColumns } = await checkQuery(explorer, dialect, definition)
          const unknown = missing(chartFields(spec), resultColumns)
          if (unknown.length > 0) {
            throw new Invalid(`The query does not return ${quote(unknown)}. It returns: ${quote(resultColumns.map((c) => c.name))}`)
          }
          await db
            .update(s.charts)
            .set({ ...definition, title, description: description ?? null, spec, baseColumns, resultColumns })
            .where(eq(s.charts.id, chartId))
          return { baseColumns, resultColumns }
        }),
    }),
  }
}
