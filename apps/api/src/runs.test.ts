import { beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as s from './db/schema.ts'
import type { FilterSelection, LookupFilter, Predicate, ScalarExpr } from './db/types.ts'
import { createApp } from './http.ts'
import { postgres } from './query/dialect.ts'
import type { GenerateDeps } from './ai/generate.ts'
import { forgetLookups } from './lookups.ts'
import type { RunView, Warehouse } from './runs.ts'
import { SnowflakeError } from './snowflake/client.ts'

// One in-process Postgres plays both the app's database and the warehouse.
const pg = new PGlite()
const db = drizzle(pg, { schema: s, casing: 'snake_case' })

/**
 * A warehouse that runs statements on Postgres. Like Snowflake it reports a
 * statement as running at first, and keeps each result under the statement's
 * ID (here: as a table of that name) for later statements to read.
 */
const warehouse: Warehouse & { submitted: string[]; forResultScan: boolean[]; executed: string[] } = {
  submitted: [],
  forResultScan: [],
  executed: [],
  async execute(sql) {
    this.executed.push(sql)
    try {
      const { rows, fields } = await pg.query<Record<string, unknown>>(sql)
      return { queryId: crypto.randomUUID(), columns: fields.map((f) => ({ name: f.name, type: 'other' as const, nativeType: 'other' })), rows, totalRows: rows.length }
    } catch (error) {
      throw new SnowflakeError(String(error), 422)
    }
  },
  async submit(sql, params = [], options = {}) {
    const id = crypto.randomUUID()
    const literal = (v: unknown) => (typeof v === 'number' ? String(v) : `'${String(v)}'`)
    statements.set(id, { sql: sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1])), polls: 0 })
    this.submitted.push(sql)
    this.forResultScan.push(options.forResultScan ?? false)
    return id
  },
  async poll(id, options = {}) {
    const statement = statements.get(id)!
    if (statement.polls++ === 0) return null
    try {
      if (statement.polls === 2) await pg.exec(`create table "${id}" as ${statement.sql}`)
      const { rows, fields } = await pg.query<Record<string, unknown>>(`select * from "${id}"`)
      return {
        queryId: id,
        columns: fields.map((f) => ({ name: f.name, type: 'other' as const, nativeType: 'other' })),
        rows: rows.slice(0, options.maxRows),
        totalRows: rows.length,
      }
    } catch (error) {
      throw new SnowflakeError(String(error), 422)
    }
  },
}
const statements = new Map<string, { sql: string; polls: number }>()

// These tests never talk to the AI.
const unused = () => {
  throw new Error('not used')
}
const deps: GenerateDeps = { db, connect: () => warehouse, dialect: postgres, model: 'unused', explore: unused }
const app = createApp(deps)
const col = (name: string): ScalarExpr => ({ type: 'column', name })

let workspaceId: string
let dataSourceId: string
let chartId: string

async function addChart(values: Partial<typeof s.charts.$inferInsert> = {}) {
  const [chart] = await db
    .insert(s.charts)
    .values({ workspaceId, dataSourceId, spec: values.sql ? { type: 'table' } : null, ...values })
    .returning()
  return chart!.id
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` })
  await pg.exec(`
    create table orders (id int primary key, region text, total int);
    insert into orders select n, 'EU', n * 10 from generate_series(1, 8) n;
    insert into orders values (9, 'US', 500);
  `)
  const [ws] = await db.insert(s.workspaces).values({ name: 'Acme', slug: 'acme' }).returning()
  const [src] = await db
    .insert(s.dataSources)
    .values({ workspaceId: ws!.id, name: 'prod', config: { account: 'a-b', warehouse: 'W', database: 'D' } })
    .returning()
  workspaceId = ws!.id
  dataSourceId = src!.id
  chartId = await addChart({
    sql: 'select * from orders',
    dimensions: [{ name: 'region', expr: col('region') }],
    measures: [{ name: 'orders', expr: { type: 'aggregate', fn: 'count' } }],
    orderBy: [{ field: 'region', direction: 'asc' }],
    drill: { rowKey: ['id'], columns: ['id', 'total'], orderBy: [], pageSize: 3 },
  })
})

async function call(method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json()) as { run: RunView; error?: string }
  return { status: response.status, run: json.run, error: json.error }
}

/** Polls a run, as a browser would, until it has finished. Returns it and how many polls that took. */
async function settle(runId: string) {
  for (let polls = 1; polls <= 10; polls++) {
    const { run } = await call('GET', `/api/runs/${runId}`)
    if (run.status !== 'running') return { run, polls }
  }
  throw new Error('run did not finish')
}

/** Runs the chart and returns the finished run, whose `drillToken` drill-downs need. */
async function runChart(id = chartId, filters?: FilterSelection) {
  const started = await call('POST', `/api/charts/${id}/runs`, filters && { filters })
  return (await settle(started.run.id)).run
}

test('a run returns every statement it submitted, the last as its sql', async () => {
  const started = await call('POST', `/api/charts/${chartId}/runs`)
  expect(started.run.statements).toEqual([started.run.sql])
  expect(started.run.sql).toContain('select * from orders')

  const { run } = await settle(started.run.id)
  expect(run.statements).toHaveLength(2)
  expect(run.statements[0]).toBe(started.run.sql)
  expect(run.sql).toBe(run.statements[1]!)
  expect(run.sql).toContain('group by')

  const raw = await runChart(await addChart({ sql: 'select 1' }))
  expect(raw).toMatchObject({ sql: 'select 1', statements: ['select 1'] })

  const drill = await call('POST', `/api/charts/${chartId}/drill-runs`, { token: run.id, row: { region: 'US' } })
  const page = (await settle(drill.run.id)).run
  expect(page.statements).toHaveLength(2)
  expect(page.sql).toBe(page.statements[1]!)
})

test('a chart run is started, polled while running, then returns the aggregated rows', async () => {
  const started = await call('POST', `/api/charts/${chartId}/runs`)
  expect(started.status).toBe(202)
  expect(started.run).toMatchObject({ kind: 'chart', status: 'running', rows: null })

  const first = await call('GET', `/api/runs/${started.run.id}`)
  expect(first.run.status).toBe('running')

  const { run } = await settle(started.run.id)
  expect(run).toMatchObject({
    status: 'succeeded',
    rows: [{ region: 'EU', orders: 8 }, { region: 'US', orders: 1 }],
    rowCount: 2,
    columns: [{ name: 'region' }, { name: 'orders' }],
  })
  expect(run.finishedAt).not.toBeNull()
  expect(run.drill).toBeUndefined()
  expect(run.drillToken).toBe(run.id)
  expect(first.run.drillToken).toBeNull()
})

test('a chart and its drill-downs read the same frozen rows; each chart run freezes new ones', async () => {
  const before = warehouse.submitted.length
  const chart = await runChart()
  // One statement froze the base rows, the next aggregated them.
  expect(warehouse.submitted.slice(before)).toEqual(['select * from orders', expect.stringContaining('group by')])
  // Only the frozen rows are stored for result_scan, which cannot read formatted dates.
  expect(warehouse.forResultScan.slice(before)).toEqual([true, false])

  await pg.exec(`begin; insert into orders values (0, 'EU', 5); delete from orders where id = 2`)
  try {
    const drill = await call('POST', `/api/charts/${chartId}/drill-runs`, { token: chart.drillToken, row: chart.rows![0] })
    const items = (await settle(drill.run.id)).run
    expect(items.drill).toMatchObject({ totalItems: 8 })
    expect(items.rows!.map((r) => r.id)).toEqual([1, 2, 3])

    // A new run of the chart sees the changed data, and so do drill-downs from it.
    const rerun = await runChart()
    expect(rerun.drillToken).not.toBe(chart.drillToken)
    const again = await call('POST', `/api/charts/${chartId}/drill-runs`, { token: rerun.drillToken, row: rerun.rows![0] })
    expect((await settle(again.run.id)).run.rows!.map((r) => r.id)).toEqual([0, 1, 3])
  } finally {
    await pg.exec('rollback')
  }
})

test('drill-down pages come from one frozen list, even when the data changes between pages', async () => {
  const { drillToken: token } = await runChart()
  const before = warehouse.submitted.length
  const started = await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: { region: 'EU', orders: 8 } })
  expect(started.status).toBe(202)
  expect(started.run).toMatchObject({ kind: 'drill', status: 'running', drill: { page: 0, totalItems: null } })

  const first = (await settle(started.run.id)).run
  expect(first.rows).toEqual([{ id: 1, total: 10 }, { id: 2, total: 20 }, { id: 3, total: 30 }])
  expect(first.columns!.map((c) => c.name)).toEqual(['id', 'total'])
  expect(first.drill).toMatchObject({ page: 0, pageSize: 3, totalItems: 8, truncated: false, hasNextPage: true, restarted: false })

  await pg.exec(`begin; insert into orders values (0, 'EU', 5); delete from orders where id = 2`)
  try {
    const second = await call('POST', `/api/charts/${chartId}/drill-runs`, { after: first.id, page: 1 })
    expect((await settle(second.run.id)).run.rows!.map((r) => r.id)).toEqual([4, 5, 6])
    // Any earlier run of the same list can be paged from.
    const third = await call('POST', `/api/charts/${chartId}/drill-runs`, { after: second.run.id, page: 2 })
    const last = (await settle(third.run.id)).run
    expect(last.rows!.map((r) => r.id)).toEqual([7, 8])
    expect(last.drill).toMatchObject({ page: 2, totalItems: 8, hasNextPage: false, row: { region: 'EU', orders: 8 } })
  } finally {
    await pg.exec('rollback')
  }
  // One statement froze the list; each page was one read of it.
  expect(warehouse.submitted.length - before).toBe(4)
})

test('when the frozen list has expired it is frozen again and the run returns its first page', async () => {
  const { drillToken: token } = await runChart()
  const started = await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: { region: 'EU' } })
  const first = (await settle(started.run.id)).run
  const [stored] = await db.select().from(s.runs).where(eq(s.runs.id, first.id))
  await pg.exec(`drop table "${stored!.snapshotQueryId}"`)

  const next = await call('POST', `/api/charts/${chartId}/drill-runs`, { after: first.id, page: 2 })
  const { run } = await settle(next.run.id)
  expect(run.status).toBe('succeeded')
  expect(run.drill).toMatchObject({ page: 0, restarted: true, totalItems: 8 })
  expect(run.rows!.map((r) => r.id)).toEqual([1, 2, 3])
})

test('a drill-down fails once the chart run\'s frozen rows are gone', async () => {
  const chart = await runChart()
  const [stored] = await db.select().from(s.runs).where(eq(s.runs.id, chart.id))
  await pg.exec(`drop table "${stored!.baseQueryId}"`)
  const drill = await call('POST', `/api/charts/${chartId}/drill-runs`, { token: chart.drillToken, row: { region: 'EU' } })
  expect((await settle(drill.run.id)).run.status).toBe('failed')
})

const totalIs = (op: '<' | '>=', value: number): Predicate => ({ type: 'compare', op, left: col('total'), right: { type: 'literal', value } })
const regionIs = (value: string): Predicate => ({ type: 'compare', op: '=', left: col('region'), right: { type: 'literal', value } })

/** The orders-by-region chart with a Region filter (several at once) and a Size filter that opens on Large. */
const addFilteredChart = (drillable = true) =>
  addChart({
    sql: 'select * from orders',
    dimensions: [{ name: 'region', expr: col('region') }],
    measures: [{ name: 'orders', expr: { type: 'aggregate', fn: 'count' } }],
    orderBy: [{ field: 'region', direction: 'asc' }],
    drill: drillable ? { rowKey: ['id'], columns: ['id', 'total'], orderBy: [], pageSize: 3 } : null,
    filters: [
      {
        name: 'Region',
        multi: true,
        options: [
          { key: 'eu', label: 'Europe', where: regionIs('EU') },
          { key: 'us', label: 'United States', where: regionIs('US') },
        ],
      },
      {
        name: 'Size',
        default: ['large'],
        options: [
          { key: 'large', label: 'Large', where: totalIs('>=', 50) },
          { key: 'small', label: 'Small', where: totalIs('<', 50) },
        ],
      },
    ],
  })

test('a chart run applies the filter options picked, or each filter\'s default', async () => {
  const id = await addFilteredChart()
  const before = warehouse.submitted.length

  const defaults = await runChart(id)
  expect(defaults.filters).toEqual({ Region: [], Size: ['large'] })
  expect(defaults.rows).toEqual([{ region: 'EU', orders: 4 }, { region: 'US', orders: 1 }])
  // The filter is part of the statement that freezes the base rows; the aggregation reads the frozen rows as they are.
  expect(warehouse.submitted[before]).toBe(`select * from (select * from orders) as unfiltered where ("total" >= 50)`)
  expect(warehouse.submitted[before + 1]).not.toContain('where')

  const all = await runChart(id, { Size: [] })
  expect(all.filters).toEqual({ Region: [], Size: [] })
  expect(all.rows).toEqual([{ region: 'EU', orders: 8 }, { region: 'US', orders: 1 }])

  const small = await runChart(id, { Region: ['us', 'eu'], Size: ['small'] })
  expect(small.filters).toEqual({ Region: ['eu', 'us'], Size: ['small'] })
  expect(small.rows).toEqual([{ region: 'EU', orders: 4 }])

  // A chart that is not drillable has nothing to freeze: one filtered statement.
  const flat = await addFilteredChart(false)
  const sent = warehouse.submitted.length
  expect((await runChart(flat, { Region: ['us'] })).rows).toEqual([{ region: 'US', orders: 1 }])
  expect(warehouse.submitted.slice(sent)).toEqual([expect.stringContaining(`where ("region" = 'US') and ("total" >= 50)`)])

  // A chart without filters reports none.
  expect((await runChart()).filters).toEqual({})
})

test('a drill-down lists the rows its chart run was filtered to, whatever is picked afterwards', async () => {
  const id = await addFilteredChart()
  const small = await runChart(id, { Size: ['small'] })
  const large = await runChart(id, { Size: ['large'] })
  const drillInto = async (chart: RunView, region: string) => {
    const row = chart.rows!.find((r) => r.region === region)!
    const started = await call('POST', `/api/charts/${id}/drill-runs`, { token: chart.drillToken, row })
    return { row, run: (await settle(started.run.id)).run }
  }

  // The earlier run is drilled into after a later one picked another option: each lists its own rows.
  const fromSmall = await drillInto(small, 'EU')
  expect(fromSmall.run.rows).toEqual([{ id: 1, total: 10 }, { id: 2, total: 20 }, { id: 3, total: 30 }])
  expect(fromSmall.run.drill!.totalItems).toBe(fromSmall.row.orders as number)
  expect(fromSmall.run.filters).toEqual({ Region: [], Size: ['small'] })

  const fromLarge = await drillInto(large, 'EU')
  expect(fromLarge.run.rows!.map((r) => r.id)).toEqual([5, 6, 7])
  expect(fromLarge.run.drill!.totalItems).toBe(fromLarge.row.orders as number)
  expect(fromLarge.run.filters).toEqual({ Region: [], Size: ['large'] })

  // A drill-down takes no filters of its own, and none are applied to it again.
  const before = warehouse.submitted.length
  const paged = await call('POST', `/api/charts/${id}/drill-runs`, { after: fromSmall.run.id, page: 1, filters: { Size: ['large'] } })
  const next = (await settle(paged.run.id)).run
  expect(next.rows).toEqual([{ id: 4, total: 40 }])
  expect(next.filters).toEqual({ Region: [], Size: ['small'] })
  expect(warehouse.submitted.slice(before).join('\n')).not.toContain('"total" <')

  // New data matching the filter does not reach a list that is frozen again after it expired.
  const [stored] = await db.select().from(s.runs).where(eq(s.runs.id, fromSmall.run.id))
  // Not in a transaction: the failed read of the dropped list would abort it.
  await pg.exec(`insert into orders values (0, 'EU', 5); drop table "${stored!.snapshotQueryId}"`)
  try {
    const again = await call('POST', `/api/charts/${id}/drill-runs`, { after: fromSmall.run.id, page: 1 })
    const { run } = await settle(again.run.id)
    expect(run.drill).toMatchObject({ page: 0, restarted: true, totalItems: 4 })
    expect(run.rows!.map((r) => r.id)).toEqual([1, 2, 3])
    expect(run.filters).toEqual({ Region: [], Size: ['small'] })
  } finally {
    await pg.exec('delete from orders where id = 0')
  }
})

test('filter selections that do not fit the chart are refused before anything is sent', async () => {
  const id = await addFilteredChart()
  const sent = warehouse.submitted.length
  const run = (body: unknown) => call('POST', `/api/charts/${id}/runs`, body)

  expect(await run({ filters: { Status: ['open'] } })).toMatchObject({ status: 400, error: 'The chart has no filter "Status"' })
  expect(await run({ filters: { Region: ['apac'] } })).toMatchObject({ status: 400, error: 'Filter "Region" has no option "apac"' })
  expect(await run({ filters: { Size: ['large', 'small'] } })).toMatchObject({ status: 400, error: 'Filter "Size" takes one option' })
  expect((await run({ filters: { Size: 'large' } })).status).toBe(400)
  expect((await run({ filters: { Size: [{ type: 'is_null' }] } })).status).toBe(400)
  expect((await run('{not json')).status).toBe(400)
  expect(await call('POST', `/api/charts/${chartId}/runs`, { filters: { Size: [] } })).toMatchObject({ status: 400, error: 'The chart has no filter "Size"' })
  expect(warehouse.submitted.length).toBe(sent)
})

test('a lookup filter offers the values its expression has in the base rows, and a run keeps the rows whose value was picked', async () => {
  const options = async (chart: string) => {
    const response = await app.request(`/api/charts/${chart}/filter-options`)
    return { status: response.status, ...((await response.json()) as { options?: unknown; error?: string }) }
  }
  const lookupChart = (sql: string, filter: Partial<LookupFilter> = {}) =>
    addChart({
      sql,
      dimensions: [{ name: 'region', expr: col('region') }],
      measures: [{ name: 'orders', expr: { type: 'aggregate', fn: 'count' } }],
      orderBy: [{ field: 'region', direction: 'asc' }],
      drill: { rowKey: ['id'], columns: ['id', 'total'], orderBy: [], pageSize: 3 },
      filters: [
        { kind: 'lookup', name: 'Region', multi: true, expr: col('region'), ...filter },
        { name: 'Size', options: [{ key: 'large', label: 'Large', where: totalIs('>=', 50) }] },
      ],
    })
  const id = await lookupChart('select * from orders')

  // Only lookup filters are listed: the distinct values, in order.
  expect(await options(id)).toEqual({ status: 200, options: { Region: [{ key: 'EU', label: 'EU' }, { key: 'US', label: 'US' }] } })
  expect(await options(chartId)).toEqual({ status: 200, options: {} })
  expect(warehouse.executed.at(-1)).toBe(`select distinct "region" as "key" from (select * from orders) as base where "region" is not null order by 1 limit 101`)

  // Nothing picked keeps every row, without reading the options.
  forgetLookups()
  const read = warehouse.executed.length
  expect((await runChart(id)).filters).toEqual({ Region: [], Size: [] })
  expect(warehouse.executed.length).toBe(read)

  const before = warehouse.submitted.length
  const us = await runChart(id, { Region: ['US'] })
  expect(us.filters).toEqual({ Region: ['US'], Size: [] })
  expect(us.rows).toEqual([{ region: 'US', orders: 1 }])
  expect(warehouse.submitted[before]).toBe(`select * from (select * from orders) as unfiltered where ("region" in ('US'))`)
  expect(warehouse.executed.length).toBe(read + 1)

  // A value new to the data becomes an option once the remembered list is dropped; until then it is not one.
  await pg.exec(`insert into orders values (10, 'APAC', 70)`)
  try {
    expect(await call('POST', `/api/charts/${id}/runs`, { filters: { Region: ['APAC'] } })).toMatchObject({ status: 400, error: 'Filter "Region" has no option "APAC"' })
    forgetLookups()
    expect(((await options(id)).options as { Region: unknown[] }).Region).toHaveLength(3)
    // Another filter's pick does not narrow the options, only the rows.
    const both = await runChart(id, { Region: ['EU', 'APAC'], Size: ['large'] })
    expect(both.filters).toEqual({ Region: ['APAC', 'EU'], Size: ['large'] })
    expect(both.rows).toEqual([{ region: 'APAC', orders: 1 }, { region: 'EU', orders: 4 }])

    // The drill-down lists the rows the run was filtered to.
    const started = await call('POST', `/api/charts/${id}/drill-runs`, { token: both.drillToken, row: both.rows![0] })
    expect((await settle(started.run.id)).run.rows).toEqual([{ id: 10, total: 70 }])
  } finally {
    await pg.exec(`delete from orders where id = 10`)
    forgetLookups()
  }

  // A key is only ever matched against the list, never spliced in.
  const sent = warehouse.submitted.length
  expect((await call('POST', `/api/charts/${id}/runs`, { filters: { Region: ["US') or 1=1 --"] } })).status).toBe(400)
  expect(warehouse.submitted.length).toBe(sent)

  // A default that names a value the data no longer holds is skipped.
  expect((await runChart(await lookupChart('select * from orders', { default: ['LATAM'] }))).filters).toEqual({ Region: [], Size: [] })
  // Options that cannot be read are reported; the chart still runs with nothing picked.
  const broken = await lookupChart('select * from no_such_table')
  expect(await options(broken)).toMatchObject({ status: 409, error: expect.stringContaining('Filter "Region" could not read its options') })
  expect((await call('POST', `/api/charts/${broken}/runs`, { filters: { Region: ['US'] } })).status).toBe(409)
})

test('a statement the warehouse rejects ends the run as failed with its message', async () => {
  const bad = await addChart({ sql: 'select * from no_such_table' })
  const started = await call('POST', `/api/charts/${bad}/runs`)
  const { run } = await settle(started.run.id)
  expect(run.status).toBe('failed')
  expect(run.error).toContain('no_such_table')
  expect(run.rows).toBeNull()
})

test('bad requests are refused before anything is sent to the warehouse', async () => {
  const { drillToken: token } = await runChart()
  const before = warehouse.submitted.length
  const missing = crypto.randomUUID()
  const raw = await addChart({ sql: 'select 1' })
  const other = await addChart({
    sql: 'select * from orders',
    dimensions: [{ name: 'region', expr: col('region') }],
    drill: { rowKey: ['id'], orderBy: [], pageSize: 3 },
  })
  const drillRun = await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: { region: 'US' } })
  const unfinished = await call('POST', `/api/charts/${chartId}/runs`)
  const rawRun = await runChart(raw)
  const empty = await addChart()
  const sent = warehouse.submitted.length

  // Nothing to run until the AI has built the chart.
  expect(await call('POST', `/api/charts/${empty}/runs`)).toMatchObject({ status: 409, error: 'The chart has not been built yet' })

  expect(await call('POST', `/api/charts/${missing}/runs`)).toMatchObject({ status: 404, error: 'Chart not found' })
  expect(await call('GET', `/api/runs/${missing}`)).toMatchObject({ status: 404, error: 'Run not found' })
  expect((await call('POST', '/api/charts/not-an-id/runs')).status).toBe(400)
  expect((await call('GET', '/api/nothing')).status).toBe(404)
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, '{not json')).status).toBe(400)
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { after: 'x', page: 0 })).error).toContain('Invalid')
  expect(rawRun).toMatchObject({ status: 'succeeded', drillToken: null })
  expect(await call('POST', `/api/charts/${raw}/drill-runs`, { token, row: {} })).toMatchObject({ status: 400, error: 'Chart is not drillable' })
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: {} })).error).toContain('no value for dimension "region"')
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: { region: { $ne: 1 } } })).status).toBe(400)
  // A drill-down needs the token of a finished chart run of the same chart.
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { row: { region: 'US' } })).status).toBe(400)
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { token: missing, row: { region: 'US' } })).status).toBe(404)
  expect((await call('POST', `/api/charts/${other}/drill-runs`, { token, row: { region: 'US' } })).status).toBe(404)
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { token: unfinished.run.id, row: { region: 'US' } })).status).toBe(409)
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { after: drillRun.run.id, page: -1 })).status).toBe(400)
  // A list cannot be paged before its first page has succeeded, or through another chart.
  expect((await call('POST', `/api/charts/${chartId}/drill-runs`, { after: drillRun.run.id, page: 1 })).status).toBe(409)
  expect(warehouse.submitted.length).toBe(sent)
  expect(sent - before).toBe(3)

  await settle(drillRun.run.id)
  expect((await call('POST', `/api/charts/${other}/drill-runs`, { after: drillRun.run.id, page: 1 })).status).toBe(404)

  // Editing the chart invalidates the tokens of its earlier chart runs.
  await db.update(s.charts).set({ description: 'edited' }).where(eq(s.charts.id, chartId))
  const stale = await call('POST', `/api/charts/${chartId}/drill-runs`, { token, row: { region: 'US' } })
  expect(stale).toMatchObject({ status: 409, error: expect.stringContaining('run it again') })
})
