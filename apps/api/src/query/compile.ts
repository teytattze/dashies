import type { ChartFilter, Dimension, DrillSpec, FilterOption, FilterSelection, LookupFilter, LookupOption, Measure, OrderBy, Predicate } from '../db/types.ts'
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

/** Most options a lookup filter offers. */
export const LOOKUP_MAX_OPTIONS = 100

export const isLookup = (filter: ChartFilter): filter is LookupFilter => filter.kind === 'lookup'

/**
 * SQL that reads a lookup filter's options: the distinct values of its
 * expression over the query's base rows (unfiltered, so one filter's picks do
 * not hide another's options), as `key`, in order. It asks for one row more
 * than `LOOKUP_MAX_OPTIONS`, so the caller can tell when there are too many.
 */
export function compileLookup(q: QueryDefinition, filter: LookupFilter, d: Dialect): string {
  const value = scalarSql(filter.expr, d)
  return `select distinct ${value} as "key" from (${compileBase(q, d)}) as base where ${value} is not null order by 1 limit ${LOOKUP_MAX_OPTIONS + 1}`
}

/** The options in a lookup's result (see `compileLookup`): one per key, labelled with it, at most `LOOKUP_MAX_OPTIONS`. */
export function lookupOptions(rows: Record<string, unknown>[]): LookupOption[] {
  const options = new Map<string, LookupOption>()
  for (const { key: value } of rows) {
    if (value == null) continue
    const key = String(value)
    if (options.has(key)) continue
    const comparable = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    options.set(key, { key, label: key, value: comparable ? value : key })
  }
  return [...options.values()].slice(0, LOOKUP_MAX_OPTIONS)
}

/** The keys a run applies to one filter: those asked for, or its default where the request does not name it. */
const asked = (filter: ChartFilter, requested: FilterSelection) =>
  Object.hasOwn(requested, filter.name) ? requested[filter.name]! : (filter.default ?? [])

/** The lookup filters whose options a run needs: those it picks from. A filter with nothing picked keeps every row whatever its options. */
export const lookupsNeeded = (filters: ChartFilter[], requested: FilterSelection = {}): LookupFilter[] =>
  filters.filter(isLookup).filter((filter) => asked(filter, requested).length > 0)

/** Throws if `requested` names a filter the chart does not have. */
export function knownFilters(filters: ChartFilter[], requested: FilterSelection = {}): void {
  const unknown = Object.keys(requested).find((name) => !filters.some((f) => f.name === name))
  if (unknown !== undefined) throw new Error(`The chart has no filter "${unknown}"`)
}

/**
 * The options a run applies: those asked for, or each filter's default where
 * the request does not name it. Returns them by filter name, and the
 * predicates that keep the matching base rows (to pass to `compileBase`).
 * Only option keys come from the client; the predicates are the stored ones,
 * or built from the values in `lookups`: the options of each lookup filter,
 * by filter name, as read from the warehouse.
 */
export function resolveFilters(
  filters: ChartFilter[],
  requested: FilterSelection = {},
  lookups: Record<string, LookupOption[]> = {},
): { selection: FilterSelection; where: Predicate[] } {
  knownFilters(filters, requested)

  const selection: FilterSelection = {}
  const where: Predicate[] = []
  for (const filter of filters) {
    const options: { key: string }[] = isLookup(filter) ? (Object.hasOwn(lookups, filter.name) ? lookups[filter.name]! : []) : filter.options
    let keys = asked(filter, requested)
    // A lookup's default may name a row that has since been removed; a request may not.
    if (isLookup(filter) && !Object.hasOwn(requested, filter.name)) keys = keys.filter((key) => options.some((o) => o.key === key))
    const missing = keys.find((key) => !options.some((o) => o.key === key))
    if (missing !== undefined) throw new Error(`Filter "${filter.name}" has no option "${missing}"`)
    // In the filter's own order, each once.
    const picked = options.filter((o) => keys.includes(o.key))
    if (picked.length > 1 && !filter.multi) throw new Error(`Filter "${filter.name}" takes one option`)
    selection[filter.name] = picked.map((o) => o.key)
    if (picked.length === 0) continue
    if (isLookup(filter)) where.push({ type: 'in', arg: filter.expr, values: (picked as LookupOption[]).map((o) => o.value) })
    else if (picked.length === 1) where.push((picked[0] as FilterOption).where)
    else where.push({ type: 'or', args: (picked as FilterOption[]).map((o) => o.where) })
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
