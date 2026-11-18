import type { ChartFilter, Dimension, DrillSpec, FilterSelection, Measure, OrderBy, Predicate } from '../db/types.ts'
import type { Dialect } from './dialect.ts'
import { aggregateSql, ident, predicateSql, scalarSql } from './expr.ts'

/** The parts of a `charts` row that determine what SQL runs. */
export type QueryDefinition = {
  sql: string
  dimensions: Dimension[]
  measures: Measure[]
  orderBy: OrderBy[]
  limit: number | null
  drill: DrillSpec | null
  filters: ChartFilter[]
}

export type CompiledSql = { sql: string; params: unknown[] }

const orderList = (orderBy: OrderBy[]) => orderBy.map((o) => `${ident(o.field)} ${o.direction === 'desc' ? 'desc' : 'asc'}`)

const QUERY_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** A stored statement result as a relation. The ID is spliced into the SQL, so it must be nothing but a query ID. */
function stored(queryId: string, d: Dialect): string {
  if (!QUERY_ID.test(queryId)) throw new Error(`Invalid query ID: ${queryId}`)
  return d.resultScan(queryId)
}

/**
 * SQL that freezes a query's base rows, run once at the start of each chart
 * run. The chart and every drill-down from it then read the stored result
 * (by this statement's query ID) rather than live tables, so they always
 * agree with each other. `where` (from `resolveFilters`) narrows them to the
 * filter options picked for the run, so the frozen rows are already filtered.
 */
export function compileBase(q: QueryDefinition, d: Dialect, where: Predicate[] = []): string {
  const sql = q.sql.trim().replace(/;+$/, '')
  if (where.length === 0) return sql
  return `select * from (${sql}) as unfiltered where ${where.map((p) => predicateSql(p, d)).join(' and ')}`
}

/**
 * The options a run applies: those asked for, or each filter's default where
 * the request does not name it. Returns them by filter name, and the
 * predicates that keep the matching base rows (to pass to `compileBase`).
 * Only option keys come from the client; the predicates are the stored ones.
 */
export function resolveFilters(filters: ChartFilter[], requested: FilterSelection = {}): { selection: FilterSelection; where: Predicate[] } {
  const unknown = Object.keys(requested).find((name) => !filters.some((f) => f.name === name))
  if (unknown !== undefined) throw new Error(`The chart has no filter "${unknown}"`)

  const selection: FilterSelection = {}
  const where: Predicate[] = []
  for (const filter of filters) {
    const asked = Object.hasOwn(requested, filter.name) ? requested[filter.name]! : (filter.default ?? [])
    const missing = asked.find((key) => !filter.options.some((o) => o.key === key))
    if (missing !== undefined) throw new Error(`Filter "${filter.name}" has no option "${missing}"`)
    // In the filter's own order, each once.
    const picked = filter.options.filter((o) => asked.includes(o.key))
    if (picked.length > 1 && !filter.multi) throw new Error(`Filter "${filter.name}" takes one option`)
    selection[filter.name] = picked.map((o) => o.key)
    if (picked.length === 1) where.push(picked[0]!.where)
    else if (picked.length > 1) where.push({ type: 'or', args: picked.map((o) => o.where) })
  }
  return { selection, where }
}

/** The base relation: the frozen rows of statement `baseQueryId`, or else the live query. */
const base = (q: QueryDefinition, d: Dialect, baseQueryId?: string, where: Predicate[] = []) =>
  baseQueryId === undefined ? `(${compileBase(q, d, where)}) as base` : `${stored(baseQueryId, d)} as base`

function positiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${what}: ${value}`)
  return value
}

/**
 * SQL whose rows feed the charts: the base relation grouped by its dimensions.
 * With `baseQueryId` it aggregates the rows frozen by `compileBase`, which are
 * already filtered; otherwise it reads the live query, narrowed by `where`.
 */
export function compileChart(q: QueryDefinition, d: Dialect, baseQueryId?: string, where: Predicate[] = []): string {
  if (q.dimensions.length === 0 && q.measures.length === 0) return q.sql

  const select = [
    ...q.dimensions.map((dim) => `${scalarSql(dim.expr, d)} as ${ident(dim.name)}`),
    ...q.measures.map((m) => `${aggregateSql(m.expr, d)} as ${ident(m.name)}`),
  ]
  const parts = [`select ${select.join(', ')}`, `from ${base(q, d, baseQueryId, where)}`]
  if (q.dimensions.length > 0) parts.push(`group by ${q.dimensions.map((_, i) => i + 1).join(', ')}`)
  if (q.orderBy.length > 0) parts.push(`order by ${orderList(q.orderBy).join(', ')}`)
  if (q.limit != null) parts.push(`limit ${positiveInt(q.limit, 'limit')}`)
  return parts.join('\n')
}

/** Most items a drill-down lists. Bounds what the first click costs. */
export const DRILL_MAX_ROWS = 10_000

/** Position of an item in the frozen list, 1-based. Added by the snapshot, hidden from users. */
export const DRILL_ROW_NUMBER = '__row'

/**
 * SQL that freezes the items behind a clicked chart row, run once per click.
 *
 * It filters the same frozen base rows (`baseQueryId`, from the chart's run)
 * by the same dimension expressions the chart grouped on, so the items are
 * exactly the rows aggregated into that data point. Each is numbered in the drill-down's sort order, ending with the
 * row key so the order is total. Pages are then read from the stored result
 * (`compileDrillPage`), not from live tables, so they cannot shift.
 *
 * One row beyond `maxRows` is selected: if it comes back, the list was cut short.
 */
export function compileDrillSnapshot(
  q: QueryDefinition,
  row: Record<string, unknown>,
  baseQueryId: string,
  d: Dialect,
  maxRows = DRILL_MAX_ROWS,
): CompiledSql {
  if (!q.drill) throw new Error('Query is not drillable')
  const { rowKey, columns, orderBy } = q.drill
  positiveInt(maxRows, 'row cap')

  const params: unknown[] = []
  const where = q.dimensions.map((dim) => {
    if (!(dim.name in row)) throw new Error(`Clicked row has no value for dimension "${dim.name}"`)
    const value = row[dim.name]
    // Nulls are written inline: not every warehouse API can bind one.
    if (value === null || value === undefined) return `${scalarSql(dim.expr, d)} is null`
    params.push(value)
    return `${scalarSql(dim.expr, d)} = ${d.placeholder(params.length)}`
  })

  const sorted = new Set(orderBy.map((o) => o.field))
  const order = [...orderList(orderBy), ...rowKey.filter((k) => !sorted.has(k)).map(ident)]
  const rowNumber = ident(DRILL_ROW_NUMBER)

  const sql = [
    `select ${columns ? columns.map(ident).join(', ') : '*'}, row_number() over (order by ${order.join(', ')}) as ${rowNumber}`,
    `from ${base(q, d, baseQueryId)}`,
    `where ${where.join(' and ')}`,
    `order by ${rowNumber}`,
    `limit ${maxRows + 1}`,
  ].join('\n')
  return { sql, params }
}

/**
 * SQL for one page of a frozen item list. `queryId` identifies the statement
 * compiled by `compileDrillSnapshot`; the warehouse keeps its result for 24 hours.
 */
export function compileDrillPage(
  q: QueryDefinition,
  queryId: string,
  page: number,
  d: Dialect,
  maxRows = DRILL_MAX_ROWS,
): string {
  if (!q.drill) throw new Error('Query is not drillable')
  if (!Number.isInteger(page) || page < 0) throw new Error(`Invalid page: ${page}`)
  const pageSize = positiveInt(q.drill.pageSize, 'page size')
  const rowNumber = ident(DRILL_ROW_NUMBER)
  const first = page * pageSize
  const last = Math.min(first + pageSize, positiveInt(maxRows, 'row cap'))

  return [
    'select *',
    `from ${stored(queryId, d)}`,
    `where ${rowNumber} > ${first} and ${rowNumber} <= ${last}`,
    `order by ${rowNumber}`,
  ].join('\n')
}
