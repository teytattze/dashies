import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import * as s from './db/schema.ts'
import type { FilterSelection, LookupFilter, LookupOption, ResultColumn } from './db/types.ts'
import {
  compileBase,
  compileChart,
  compileDrillPage,
  compileDrillSnapshot,
  DRILL_MAX_ROWS,
  compileLookup,
  DRILL_ROW_NUMBER,
  isLookup,
  knownFilters,
  lookupsNeeded,
  resolveFilters,
} from './query/compile.ts'
import { cachedLookup } from './lookups.ts'
import type { Dialect } from './query/dialect.ts'
import { type QueryResult, SnowflakeError } from './snowflake/client.ts'

/**
 * Runs are asynchronous: starting one submits a statement to the
 * warehouse and returns at once; the caller then polls `getRun`. Each poll
 * asks the warehouse about the statement and moves the run forward, so no work
 * happens in the background of this process and a restart loses nothing.
 *
 * A chart run of a drillable query takes two statements: one freezes the
 * query's base rows, the next aggregates the frozen copy. A drill-down names
 * the chart run it was clicked on (by its `drillToken`) and lists items from
 * that same copy, so the chart and its item lists always agree. Every chart
 * run freezes a fresh copy.
 *
 * A chart run applies the filter options picked for it to the base rows it
 * reads, before freezing them. A drill-down is never given filters of its own:
 * it reads its chart run's copy, which holds only the rows that run charted.
 *
 * The options of a lookup filter are the distinct values of its expression in
 * the base rows, read from the warehouse (see `lookups.ts`). A run that picks from one reads them first, to check the
 * picked keys and write their values into its SQL; that one read is waited for.
 */

/** Most aggregated rows a chart receives. */
export const CHART_MAX_ROWS = 5_000

/** The part of the warehouse client that runs need. `SnowflakeClient` is one. */
export type Warehouse = {
  /** Starts a statement and returns its handle, which is also its query ID. */
  submit(sql: string, params?: unknown[], options?: { forResultScan?: boolean }): Promise<string>
  /** The statement's result, or null while it is still running. Throws `SnowflakeError` if it failed. */
  poll(handle: string, options?: { maxRows?: number }): Promise<QueryResult | null>
  /** Runs a statement and waits for its result. Only for small reads: the options of lookup filters. */
  execute(sql: string, params?: unknown[], options?: { maxRows?: number }): Promise<QueryResult>
}

export type Database = PgDatabase<any, typeof s>

export type RunDeps = {
  db: Database
  connect(source: typeof s.dataSources.$inferSelect): Warehouse | Promise<Warehouse>
  dialect: Dialect
}

type Run = typeof s.runs.$inferSelect
/** A chart the AI has built: it has a query to run. */
type Query = typeof s.charts.$inferSelect & { sql: string }

/** A problem with the request, reported to the client with this HTTP status. */
export class RunError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'RunError'
  }
}

/** What the API returns for a run. */
export type RunView = {
  id: string
  chartId: string
  kind: 'chart' | 'drill'
  status: 'running' | 'succeeded' | 'failed'
  error: string | null
  /** The statement the run submitted last, as the warehouse received it: the one its rows come from once it has succeeded. */
  sql: string
  /**
   * Every statement the run submitted, in order; `sql` is the last. A later one
   * reads the stored result of an earlier one (`result_scan`), so the tables
   * and filters are in the first.
   */
  statements: string[]
  /** Null until the run has succeeded. */
  columns: ResultColumn[] | null
  rows: Record<string, unknown>[] | null
  /** Chart runs: rows the statement produced, which exceeds `rows.length` if the result was capped. */
  rowCount: number | null
  startedAt: Date
  finishedAt: Date | null
  /** The option keys applied, for every filter of the chart. Drill runs: those of the chart run drilled into. */
  filters: FilterSelection
  /**
   * Chart runs: pass this to start a drill-down into one of this run's rows.
   * Null if the run has not succeeded or the query is not drillable. It stops
   * working once the warehouse drops the frozen rows, 24 hours after the run.
   */
  drillToken?: string | null
  drill?: {
    /** The clicked row's dimension values. */
    row: Record<string, unknown>
    page: number
    pageSize: number
    /** Items in the frozen list; null while it is still being frozen. */
    totalItems: number | null
    /** The data point has more items than the list holds. */
    truncated: boolean
    hasNextPage: boolean
    /** The list had expired, so it was frozen again and this is its first page. */
    restarted: boolean
  }
}

export type DrillRequest =
  /** A click on a data point: the `drillToken` of the chart run that drew it, and the row's dimension values by name. */
  | { token: string; row: Record<string, unknown> }
  /** Another page of the list an earlier drill run of this chart showed. */
  | { after: string; page: number }

/**
 * Starts running a chart's aggregated result. `filters` picks options by
 * filter name; a filter it does not name applies its default.
 */
export async function startChartRun(deps: RunDeps, chartId: string, filters?: FilterSelection): Promise<RunView> {
  const { query, warehouse } = await load(deps, chartId)
  // Checked first, so a request that names no such filter reads nothing.
  invalidAs400(() => knownFilters(query.filters, filters))
  const lookups = await readLookups(deps, query, warehouse, lookupsNeeded(query.filters, filters))
  const { selection, where } = invalidAs400(() => resolveFilters(query.filters, filters, lookups))
  const chart = invalidAs400(() => compileChart(query, deps.dialect, undefined, where))
  // Only a drillable query needs its base rows frozen.
  const sql = query.drill ? invalidAs400(() => compileBase(query, deps.dialect, where)) : chart
  return start(deps, query, warehouse, { kind: 'chart', sql, filters: selection }, sql, [], query.drill !== null)
}

/** What a viewer can pick from each lookup filter of a chart right now, by filter name. Filters with written-out options are not listed. */
export async function getFilterOptions(deps: RunDeps, chartId: string): Promise<Record<string, { key: string; label: string }[]>> {
  const { query, warehouse } = await load(deps, chartId)
  const lookups = await readLookups(deps, query, warehouse, query.filters.filter(isLookup))
  return Object.fromEntries(Object.entries(lookups).map(([name, options]) => [name, options.map(({ key, label }) => ({ key, label }))]))
}

async function readLookups(deps: RunDeps, query: Query, warehouse: Warehouse, filters: LookupFilter[]): Promise<Record<string, LookupOption[]>> {
  const read = async (filter: LookupFilter) => {
    const sql = invalidAs400(() => compileLookup(query, filter, deps.dialect))
    try {
      return [filter.name, await cachedLookup(query.dataSourceId, warehouse, sql)] as const
    } catch (error) {
      // 422 = the statement itself failed, e.g. a table of the base SQL is gone.
      if (!(error instanceof SnowflakeError) || error.status !== 422) throw error
      throw new RunError(409, `Filter "${filter.name}" could not read its options: ${error.message}`)
    }
  }
  return Object.fromEntries(await Promise.all(filters.map(read)))
}

/** Starts running one page of the items behind a clicked data point. */
export async function startDrillRun(deps: RunDeps, chartId: string, request: DrillRequest): Promise<RunView> {
  const { query, warehouse } = await load(deps, chartId)
  if (!query.drill) throw new RunError(400, 'Chart is not drillable')

  if ('row' in request) {
    // The token is the chart run's ID; the frozen rows it stands for come from our own record.
    const [chart] = await deps.db
      .select()
      .from(s.runs)
      .where(and(eq(s.runs.id, request.token), eq(s.runs.chartId, chartId), eq(s.runs.kind, 'chart')))
    if (!chart) throw new RunError(404, 'Chart run not found')
    const baseQueryId = chart.status === 'succeeded' ? chart.baseQueryId : null
    if (!baseQueryId) throw new RunError(409, 'The chart run has no data to drill into')
    // The frozen rows were chosen by the query as it was then; its dimensions may no longer match them.
    if (query.updatedAt > chart.startedAt) throw new RunError(409, 'The chart has changed since it ran; run it again')
    const { sql, params } = invalidAs400(() => compileDrillSnapshot(query, request.row, baseQueryId, deps.dialect))
    return start(
      deps,
      query,
      warehouse,
      { kind: 'drill', sql, baseQueryId, filters: chart.filters, drillRow: request.row, page: 0 },
      sql,
      params,
    )
  }

  const [previous] = await deps.db
    .select()
    .from(s.runs)
    .where(and(eq(s.runs.id, request.after), eq(s.runs.chartId, chartId), eq(s.runs.kind, 'drill')))
  if (!previous) throw new RunError(404, 'Drill run not found')
  if (previous.status !== 'succeeded' || !previous.snapshotQueryId) {
    throw new RunError(409, 'The earlier drill run has not succeeded')
  }
  // The list to read comes from our own record of the earlier run, never from the client.
  const sql = invalidAs400(() => compileDrillPage(query, previous.snapshotQueryId!, request.page, deps.dialect))
  return start(
    deps,
    query,
    warehouse,
    {
      kind: 'drill',
      sql,
      baseQueryId: previous.baseQueryId,
      filters: previous.filters,
      drillRow: previous.drillRow,
      page: request.page,
      snapshotQueryId: previous.snapshotQueryId,
      snapshotRowCount: previous.snapshotRowCount,
      snapshotTruncated: previous.snapshotTruncated,
    },
    sql,
    [],
  )
}

/** A run's current state. While it is running, this checks on its statement and moves it forward. */
export async function getRun(deps: RunDeps, runId: string): Promise<RunView> {
  const [found] = await deps.db.select().from(s.runs).where(eq(s.runs.id, runId))
  if (!found) throw new RunError(404, 'Run not found')
  const { query, warehouse } = await load(deps, found.chartId)
  const run = found.status === 'running' ? await advance(deps, found, query, warehouse) : found
  return view(run, query)
}

async function load(deps: RunDeps, chartId: string) {
  const [row] = await deps.db
    .select({ chart: s.charts, source: s.dataSources })
    .from(s.charts)
    .innerJoin(s.dataSources, eq(s.dataSources.id, s.charts.dataSourceId))
    .where(eq(s.charts.id, chartId))
  if (!row) throw new RunError(404, 'Chart not found')
  const { sql } = row.chart
  if (sql === null) throw new RunError(409, 'The chart has not been built yet')
  return { query: { ...row.chart, sql }, warehouse: await deps.connect(row.source) }
}

/** Compiling rejects malformed definitions and requests with a plain Error. */
function invalidAs400<T>(compile: () => T): T {
  try {
    return compile()
  } catch (error) {
    throw new RunError(400, error instanceof Error ? error.message : String(error))
  }
}

async function start(
  deps: RunDeps,
  query: Query,
  warehouse: Warehouse,
  values: Omit<typeof s.runs.$inferInsert, 'chartId' | 'status'>,
  sql: string,
  params: unknown[],
  /** The statement freezes the query's base rows: its result is what later statements read. */
  freezesBase = false,
): Promise<RunView> {
  let outcome: Pick<typeof s.runs.$inferInsert, 'status' | 'statementHandle' | 'baseQueryId' | 'error' | 'finishedAt'>
  try {
    // A drill run without a frozen list yet starts by freezing one.
    const forResultScan = freezesBase || (values.kind === 'drill' && !values.snapshotQueryId)
    const statementHandle = await warehouse.submit(sql, params, { forResultScan })
    outcome = { status: 'running', statementHandle, ...(freezesBase ? { baseQueryId: statementHandle } : {}) }
  } catch (error) {
    // Recorded rather than thrown, so the failure shows in the run history the AI reads.
    if (!(error instanceof SnowflakeError)) throw error
    outcome = { status: 'failed', error: error.message, finishedAt: new Date() }
  }
  const [run] = await deps.db
    .insert(s.runs)
    .values({ ...values, ...outcome, statements: [sql], chartId: query.id })
    .returning()
  return view(run!, query)
}

async function advance(deps: RunDeps, run: Run, query: Query, warehouse: Warehouse): Promise<Run> {
  const handle = run.statementHandle
  if (!handle) return run
  const drill = run.kind === 'drill' ? query.drill : null
  // A chart run of a drillable query first freezes the base rows (filtered), then aggregates them.
  const freezingBase = run.kind === 'chart' && run.baseQueryId === handle
  // A drill run first freezes the item list, then reads its page from the frozen list.
  const freezing = drill !== null && !run.snapshotQueryId

  // Only applies if the run is still waiting on the statement we checked:
  // concurrent polls of one run must not both move it forward.
  const update = async (values: Partial<typeof s.runs.$inferInsert>): Promise<Run> => {
    const [updated] = await deps.db
      .update(s.runs)
      .set(values)
      .where(and(eq(s.runs.id, run.id), eq(s.runs.statementHandle, handle)))
      .returning()
    if (updated) return updated
    const [current] = await deps.db.select().from(s.runs).where(eq(s.runs.id, run.id))
    return current ?? run
  }
  const finished = () => {
    const finishedAt = new Date()
    return { statementHandle: null, finishedAt, durationMs: finishedAt.getTime() - run.startedAt.getTime() }
  }
  const submitOrFail = async (sql: string, params: unknown[], values: Partial<typeof s.runs.$inferInsert>, forResultScan = false) => {
    try {
      return await update({ ...values, sql, statements: [...statements(run), sql], statementHandle: await warehouse.submit(sql, params, { forResultScan }) })
    } catch (error) {
      if (!(error instanceof SnowflakeError)) throw error
      return update({ ...finished(), status: 'failed', error: error.message })
    }
  }

  let result: QueryResult | null
  try {
    result = await warehouse.poll(handle, { maxRows: freezingBase || freezing ? 0 : drill ? drill.pageSize : CHART_MAX_ROWS })
  } catch (error) {
    // 422 = the statement itself failed. Anything else (network, auth) may pass, so the run stays running.
    if (!(error instanceof SnowflakeError) || error.status !== 422) throw error
    if (drill && !freezing && !run.restarted && run.drillRow && run.baseQueryId) {
      // Reading a page of a frozen list fails once Snowflake has dropped the
      // list (after 24 hours): freeze it again from the chart run's base rows
      // and start over from its first page.
      const snapshot = compileDrillSnapshot(query, run.drillRow, run.baseQueryId, deps.dialect)
      return submitOrFail(
        snapshot.sql,
        snapshot.params,
        { page: 0, restarted: true, snapshotQueryId: null, snapshotRowCount: null, snapshotTruncated: null },
        true,
      )
    }
    return update({ ...finished(), status: 'failed', error: error.message })
  }
  if (!result) return run

  if (freezingBase) return submitOrFail(compileChart(query, deps.dialect, handle), [], {})
  if (freezing) {
    return submitOrFail(compileDrillPage(query, handle, run.page ?? 0, deps.dialect), [], {
      snapshotQueryId: handle,
      snapshotRowCount: Math.min(result.totalRows, DRILL_MAX_ROWS),
      snapshotTruncated: result.totalRows > DRILL_MAX_ROWS,
    })
  }

  // The row number orders the frozen list and is not part of the items.
  const hidden = drill ? DRILL_ROW_NUMBER : undefined
  return update({
    ...finished(),
    status: 'succeeded',
    columns: result.columns.filter((c) => c.name !== hidden).map(({ name, type }) => ({ name, type })),
    rows: hidden ? result.rows.map(({ [hidden]: _, ...item }) => item) : result.rows,
    rowCount: drill ? result.rows.length : result.totalRows,
  })
}

/** Runs recorded before `statements` existed kept only their last statement. */
const statements = (run: Run) => (run.statements.length > 0 ? run.statements : [run.sql])

function view(run: Run, query: Query): RunView {
  const base: RunView = {
    id: run.id,
    chartId: run.chartId,
    kind: run.kind,
    status: run.status,
    error: run.error,
    sql: run.sql,
    statements: statements(run),
    columns: run.columns,
    rows: run.rows,
    rowCount: run.rowCount,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    filters: run.filters,
  }
  if (run.kind !== 'drill') {
    const drillable = run.status === 'succeeded' && run.baseQueryId !== null && query.drill !== null
    return { ...base, drillToken: drillable ? run.id : null }
  }
  const page = run.page ?? 0
  const pageSize = query.drill?.pageSize ?? 0
  return {
    ...base,
    drill: {
      row: run.drillRow ?? {},
      page,
      pageSize,
      totalItems: run.snapshotRowCount,
      truncated: run.snapshotTruncated ?? false,
      hasNextPage: run.snapshotRowCount !== null && (page + 1) * pageSize < run.snapshotRowCount,
      restarted: run.restarted,
    },
  }
}
