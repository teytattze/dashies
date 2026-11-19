import { beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type { AggregateExpr, LookupFilter, Predicate, ScalarExpr } from '../db/types.ts'
import {
  compileBase,
  compileChart,
  compileDrillPage,
  compileDrillSnapshot,
  compileLookup,
  LOOKUP_MAX_OPTIONS,
  lookupOptions,
  lookupsNeeded,
  type QueryDefinition,
  resolveFilters,
} from './compile.ts'
import { postgres, snowflake } from './dialect.ts'
import { aggregateSql, scalarSql } from './expr.ts'

const col = (name: string): ScalarExpr => ({ type: 'column', name })
const sum = (name: string): AggregateExpr => ({ type: 'aggregate', fn: 'sum', arg: col(name) })
const count: AggregateExpr = { type: 'aggregate', fn: 'count' }
const is = (name: string, op: '=' | '<' | '>=', value: string | number): Predicate => ({
  type: 'compare',
  op,
  left: col(name),
  right: { type: 'literal', value },
})

// Compiled SQL is executed on an in-process Postgres (via the test-only postgres
// dialect) to check its results; Snowflake output is checked as text below.
const pg = new PGlite()

const revenueByRegion: QueryDefinition = {
  sql: 'select o.id, o.region, o.total, o.placed_on from orders o where o.total > 0;',
  dimensions: [{ name: 'region', expr: col('region') }],
  measures: [
    { name: 'revenue', expr: sum('total') },
    { name: 'orders', expr: count },
  ],
  orderBy: [{ field: 'revenue', direction: 'desc' }],
  limit: null,
  // Every EU order shares one date, so only the row key separates them.
  drill: { rowKey: ['id'], columns: ['id', 'total'], orderBy: [{ field: 'placed_on', direction: 'desc' }], pageSize: 3 },
  filters: [],
}

beforeAll(async () => {
  await pg.exec(`
    create table orders (id int primary key, region text, total numeric, placed_on date);
    insert into orders
      select n, 'EU', n * 10, date '2026-11-01' from generate_series(1, 8) n;
    insert into orders values
      (9, 'US', 500, '2026-11-02'), (10, null, 70, '2026-11-03'), (11, 'EU', 0, '2026-11-01');
  `)
})

/**
 * Stands in for the warehouse storing a statement's result: runs the statement
 * and saves its rows as a table named after a fresh query ID.
 */
async function store(sql: string, params: unknown[] = []) {
  // `create table as` takes no bind parameters, so write them in as literals.
  const literal = (v: unknown) => (typeof v === 'number' ? String(v) : `'${v instanceof Date ? v.toISOString() : String(v)}'`)
  const queryId = crypto.randomUUID()
  await pg.exec(`create table "${queryId}" as ${sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]))}`)
  return queryId
}

/** Freezes the base rows, as a chart run does: only those the picked filter options keep. */
const freeze = (q: QueryDefinition, where: Predicate[] = []) => store(compileBase(q, postgres, where))

/** Freezes the item list behind a clicked row; the base rows too, unless given. */
async function snapshot(q: QueryDefinition, row: Record<string, unknown>, maxRows?: number, baseQueryId?: string) {
  const { sql, params } = compileDrillSnapshot(q, row, baseQueryId ?? (await freeze(q)), postgres, maxRows)
  return store(sql, params)
}

async function readPages(q: QueryDefinition, queryId: string, maxRows?: number) {
  const pages: Record<string, unknown>[][] = []
  for (let page = 0; ; page++) {
    const { rows } = await pg.query<Record<string, unknown>>(compileDrillPage(q, queryId, page, postgres, maxRows))
    if (rows.length === 0) return pages
    pages.push(rows.map(({ __row: _, ...item }) => item))
  }
}

const allPages = async (q: QueryDefinition, row: Record<string, unknown>) => readPages(q, await snapshot(q, row))

test('drill-down pages are exactly the rows behind the clicked data point', async () => {
  const chart = await pg.query<{ region: string | null; revenue: string; orders: number }>(compileChart(revenueByRegion, postgres))
  expect(chart.rows.map((r) => r.region)).toEqual(['US', 'EU', null])
  const eu = chart.rows[1]!

  const pages = await allPages(revenueByRegion, eu)
  expect(pages.map((p) => p.length)).toEqual([3, 3, 2])

  const items = pages.flat()
  // No overlaps or gaps between pages, and the base query's own filter (total > 0) still applies.
  expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(Object.keys(items[0]!)).toEqual(['id', 'total'])
  expect(items).toHaveLength(eu.orders)
  expect(items.reduce((sum, i) => sum + Number(i.total), 0)).toBe(Number(eu.revenue))
})

test('pages do not shift when the data changes after the click', async () => {
  const queryId = await snapshot(revenueByRegion, { region: 'EU' })
  const first = await pg.query<{ id: number }>(compileDrillPage(revenueByRegion, queryId, 0, postgres))
  expect(first.rows.map((r) => r.id)).toEqual([1, 2, 3])

  // A new order that sorts first and a deleted one would both shift live limit/offset pages.
  await pg.exec(`begin; insert into orders values (0, 'EU', 5, '2026-11-09'); delete from orders where id = 2`)
  try {
    const pages = await readPages(revenueByRegion, queryId)
    expect(pages.flat().map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  } finally {
    await pg.exec('rollback')
  }
})

test('a chart and its drill-downs agree even when the data changes after the chart ran', async () => {
  const baseQueryId = await freeze(revenueByRegion)
  await pg.exec(`begin; insert into orders values (0, 'EU', 5, '2026-11-09'); delete from orders where id = 2`)
  try {
    type Row = { region: string | null; revenue: string; orders: number }
    const chart = await pg.query<Row>(compileChart(revenueByRegion, postgres, baseQueryId))
    const live = await pg.query<Row>(compileChart(revenueByRegion, postgres))
    const eu = chart.rows.find((r) => r.region === 'EU')!
    expect(eu.orders).toBe(8)
    expect(live.rows.find((r) => r.region === 'EU')!.revenue).not.toBe(eu.revenue)

    const items = (await readPages(revenueByRegion, await snapshot(revenueByRegion, eu, undefined, baseQueryId))).flat()
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(items.reduce((sum, i) => sum + Number(i.total), 0)).toBe(Number(eu.revenue))
  } finally {
    await pg.exec('rollback')
  }
})

test('the item list is capped, keeping the first rows in sort order', async () => {
  const queryId = await snapshot(revenueByRegion, { region: 'EU' }, 4)
  // One row past the cap is stored so the caller can tell the list was cut short.
  const stored = await pg.query<{ n: number }>(`select count(*)::int as n from "${queryId}"`)
  expect(stored.rows[0]!.n).toBe(5)
  const pages = await readPages(revenueByRegion, queryId, 4)
  expect(pages.map((p) => p.map((i) => i.id))).toEqual([[1, 2, 3], [4]])
})

test('a null dimension value drills into the null group', async () => {
  const pages = await allPages(revenueByRegion, { region: null })
  expect(pages.flat().map((i) => i.id)).toEqual([10])
})

test('an expression dimension filters the drill-down by the same expression', async () => {
  const byDay: QueryDefinition = {
    ...revenueByRegion,
    dimensions: [{ name: 'week', expr: { type: 'date_trunc', unit: 'week', arg: col('placed_on') } }],
    orderBy: [{ field: 'week', direction: 'asc' }],
  }
  const chart = await pg.query<{ week: Date; orders: number }>(compileChart(byDay, postgres))
  for (const row of chart.rows) {
    const items = (await allPages(byDay, row)).flat()
    expect(items).toHaveLength(row.orders)
  }
})

const filtered: QueryDefinition = {
  ...revenueByRegion,
  filters: [
    {
      name: 'Region',
      multi: true,
      options: [
        { key: 'eu', label: 'Europe', where: is('region', '=', 'EU') },
        { key: 'us', label: 'United States', where: is('region', '=', 'US') },
      ],
    },
    {
      name: 'Size',
      default: ['large'],
      options: [
        { key: 'large', label: 'Large', where: is('total', '>=', 50) },
        { key: 'small', label: 'Small', where: is('total', '<', 50) },
      ],
    },
  ],
}

test('a run applies the options asked for, or each filter\'s default', () => {
  const { filters } = filtered
  expect(resolveFilters(filters).selection).toEqual({ Region: [], Size: ['large'] })
  expect(resolveFilters(filters).where).toEqual([is('total', '>=', 50)])
  // An empty list overrides the default: every row.
  expect(resolveFilters(filters, { Size: [] })).toEqual({ selection: { Region: [], Size: [] }, where: [] })
  // Several options of one filter are OR-ed, in the filter's own order, each once.
  expect(resolveFilters(filters, { Region: ['us', 'eu', 'us'], Size: ['small'] })).toEqual({
    selection: { Region: ['eu', 'us'], Size: ['small'] },
    where: [{ type: 'or', args: [is('region', '=', 'EU'), is('region', '=', 'US')] }, is('total', '<', 50)],
  })
  expect(resolveFilters([])).toEqual({ selection: {}, where: [] })

  expect(() => resolveFilters(filters, { Status: ['open'] })).toThrow('The chart has no filter "Status"')
  expect(() => resolveFilters(filters, { Region: ['apac'] })).toThrow('Filter "Region" has no option "apac"')
  expect(() => resolveFilters(filters, { Size: ['large', 'small'] })).toThrow('Filter "Size" takes one option')
  // Names that exist on every object are not filters.
  expect(() => resolveFilters(filters, { toString: [] })).toThrow('no filter "toString"')
})

test('a lookup filter keeps the rows whose value is one of the picked options', () => {
  const lookup: LookupFilter = { kind: 'lookup', name: 'Region', multi: true, expr: { type: 'column', name: 'region' }, default: ['US', 'GONE'] }
  // The options are read from the base rows as they are, whatever the other filters pick.
  expect(compileLookup({ ...filtered, sql: 'select * from orders;' }, lookup, postgres)).toBe(
    'select distinct "region" as "key" from (select * from orders) as base where "region" is not null order by 1 limit 101',
  )
  expect(compileLookup(filtered, { ...lookup, expr: { type: 'date_trunc', unit: 'month', arg: { type: 'column', name: 'a"b' } } }, snowflake)).toContain(
    `select distinct date_trunc('month', "a""b") as "key"`,
  )

  // One option per value, labelled with it; a key keeps its value's type.
  const options = lookupOptions([{ key: 'US' }, { key: 7 }, { key: 'US' }, { key: null }])
  expect(options).toEqual([{ key: 'US', label: 'US', value: 'US' }, { key: '7', label: '7', value: 7 }])
  expect(lookupOptions(Array.from({ length: 150 }, (_, key) => ({ key })))).toHaveLength(LOOKUP_MAX_OPTIONS)

  const lookups = { Region: options }
  // The default applies, less the option that no longer exists.
  expect(resolveFilters([lookup], {}, lookups)).toEqual({ selection: { Region: ['US'] }, where: [{ type: 'in', arg: lookup.expr, values: ['US'] }] })
  expect(resolveFilters([lookup], { Region: ['7', 'US'] }, lookups)).toEqual({
    selection: { Region: ['US', '7'] },
    where: [{ type: 'in', arg: lookup.expr, values: ['US', 7] }],
  })
  expect(resolveFilters([lookup], { Region: [] }, lookups)).toEqual({ selection: { Region: [] }, where: [] })
  expect(() => resolveFilters([lookup], { Region: ['GONE'] }, lookups)).toThrow('Filter "Region" has no option "GONE"')
  expect(() => resolveFilters([{ ...lookup, multi: false }], { Region: ['7', 'US'] }, lookups)).toThrow('takes one option')
  // Options that were not read are not options.
  expect(() => resolveFilters([lookup], { Region: ['US'] })).toThrow('has no option "US"')

  // Only the filters a run picks from need their options read.
  expect(lookupsNeeded([lookup, ...filtered.filters])).toEqual([lookup])
  expect(lookupsNeeded([lookup], { Region: [] })).toEqual([])
  expect(lookupsNeeded([{ ...lookup, default: undefined }], { Region: ['US'] })).toHaveLength(1)
})

test('a filtered chart and its drill-downs keep exactly the same rows', async () => {
  type Row = { region: string | null; revenue: string; orders: number }
  const { where } = resolveFilters(filtered.filters, { Region: ['eu'] })
  const baseQueryId = await freeze(filtered, where)
  const chart = await pg.query<Row>(compileChart(filtered, postgres, baseQueryId))
  // EU orders of 50 or more: the Size default applies alongside the Region asked for.
  expect(chart.rows).toEqual([{ region: 'EU', revenue: '260', orders: 4 }])
  // A chart that is not drillable reads the live query with the same filter.
  expect((await pg.query<Row>(compileChart(filtered, postgres, undefined, where))).rows).toEqual(chart.rows)

  const eu = chart.rows[0]!
  const items = (await readPages(filtered, await snapshot(filtered, eu, undefined, baseQueryId))).flat()
  expect(items.map((i) => i.id)).toEqual([5, 6, 7, 8])
  expect(items).toHaveLength(eu.orders)
  expect(items.reduce((sum, i) => sum + Number(i.total), 0)).toBe(Number(eu.revenue))

  // The same data point under another option lists that option's rows instead.
  const small = await freeze(filtered, resolveFilters(filtered.filters, { Size: ['small'] }).where)
  const other = (await readPages(filtered, await snapshot(filtered, { region: 'EU' }, undefined, small))).flat()
  expect(other.map((i) => i.id)).toEqual([1, 2, 3, 4])
})

test('several options of a filter keep the rows of any of them', async () => {
  const { where } = resolveFilters(filtered.filters, { Region: ['eu', 'us'], Size: [] })
  const chart = await pg.query<{ region: string | null; orders: number }>(compileChart(filtered, postgres, await freeze(filtered, where)))
  // The null region matches neither option.
  expect(chart.rows.map((r) => [r.region, r.orders])).toEqual([['US', 1], ['EU', 8]])
})

test('a top-N limit ranks the filtered rows', async () => {
  const top: QueryDefinition = { ...filtered, limit: 1 }
  const first = async (requested: Record<string, string[]>) => {
    const { where } = resolveFilters(top.filters, requested)
    return (await pg.query<{ region: string }>(compileChart(top, postgres, await freeze(top, where)))).rows.map((r) => r.region)
  }
  expect(await first({ Size: [] })).toEqual(['US'])
  expect(await first({ Size: ['small'] })).toEqual(['EU'])
})

test('a query without dimensions or measures runs as written and cannot be drilled', () => {
  const raw: QueryDefinition = { sql: 'select 1', dimensions: [], measures: [], orderBy: [], limit: null, drill: null, filters: [] }
  expect(compileChart(raw, postgres)).toBe('select 1')
  expect(() => compileDrillSnapshot(raw, {}, crypto.randomUUID(), postgres)).toThrow('not drillable')
})

test('drilling requires a value for every dimension', () => {
  expect(() => compileDrillSnapshot(revenueByRegion, {}, crypto.randomUUID(), postgres)).toThrow('no value for dimension "region"')
  expect(() => compileDrillSnapshot(revenueByRegion, { region: 'EU' }, "x') --", snowflake)).toThrow('Invalid query ID')
  expect(() => compileChart(revenueByRegion, snowflake, "x') --")).toThrow('Invalid query ID')
  expect(() => compileDrillPage(revenueByRegion, "x') union select 1 --", 0, snowflake)).toThrow('Invalid query ID')
})

test('measures support filtered aggregates and safe decimal division', async () => {
  const q: QueryDefinition = {
    ...revenueByRegion,
    sql: 'select * from orders',
    measures: [
      { name: 'orders', expr: count },
      {
        name: 'big_share',
        expr: {
          type: 'arithmetic',
          op: '/',
          left: { type: 'aggregate', fn: 'count', where: { type: 'compare', op: '>=', left: col('total'), right: { type: 'literal', value: 50 } } },
          right: count,
        },
      },
      { name: 'per_unit', expr: { type: 'arithmetic', op: '/', left: count, right: sum('total') } },
    ],
    orderBy: [{ field: 'region', direction: 'asc' }],
  }
  const { rows } = await pg.query<{ region: string; orders: number; big_share: string }>(compileChart(q, postgres))
  const eu = rows.find((r) => r.region === 'EU')!
  expect(eu.orders).toBe(9)
  // 4 of 9 EU orders are >= 50; integer counts must not truncate to 0.
  expect(Number(eu.big_share)).toBeCloseTo(4 / 9)
})

test('a bucketed dimension drills into its bucket', async () => {
  const q: QueryDefinition = {
    ...revenueByRegion,
    dimensions: [{ name: 'size', expr: { type: 'bin', width: 30, arg: col('total') } }],
    orderBy: [{ field: 'size', direction: 'asc' }],
  }
  const chart = await pg.query<{ size: string; orders: number }>(compileChart(q, postgres))
  expect(chart.rows.map((r) => [Number(r.size), r.orders])).toEqual([[0, 2], [30, 3], [60, 4], [480, 1]])
  const items = (await allPages(q, chart.rows[1]!)).flat()
  expect(items.map((i) => i.id).sort()).toEqual([3, 4, 5])
})

test('Snowflake: chart and drill-down SQL', () => {
  const q: QueryDefinition = {
    sql: 'select * from orders',
    dimensions: [
      { name: 'week', expr: { type: 'date_trunc', unit: 'week', arg: col('PLACED_ON') } },
      { name: 'weekday', expr: { type: 'date_part', part: 'day_of_week', arg: col('PLACED_ON') } },
    ],
    measures: [
      { name: 'revenue', expr: sum('TOTAL') },
      {
        name: 'eu_share',
        expr: {
          type: 'arithmetic',
          op: '/',
          left: { type: 'aggregate', fn: 'count', where: { type: 'compare', op: '=', left: col('REGION'), right: { type: 'literal', value: 'EU' } } },
          right: count,
        },
      },
      {
        name: 'paying_customers',
        expr: { type: 'aggregate', fn: 'count_distinct', arg: col('CUSTOMER_ID'), where: { type: 'compare', op: '>', left: col('TOTAL'), right: { type: 'literal', value: 0 } } },
      },
    ],
    orderBy: [{ field: 'week', direction: 'asc' }],
    limit: 52,
    drill: { rowKey: ['ID'], orderBy: [{ field: 'TOTAL', direction: 'desc' }], pageSize: 25 },
    filters: [],
  }

  expect(compileChart(q, snowflake)).toBe(
    [
      `select date_trunc('week', "PLACED_ON") as "week", extract(dayofweekiso from "PLACED_ON") as "weekday", ` +
        `sum("TOTAL") as "revenue", ` +
        `(count(case when ("REGION" = 'EU') then 1 end) / nullif(count(*), 0)) as "eu_share", ` +
        `count(distinct case when ("TOTAL" > 0) then "CUSTOMER_ID" end) as "paying_customers"`,
      'from (select * from orders) as base',
      'group by 1, 2',
      'order by "week" asc',
      'limit 52',
    ].join('\n'),
  )

  const baseQueryId = '0a0b0c0d-0000-1111-2222-333344445555'
  expect(compileBase(q, snowflake)).toBe('select * from orders')
  expect(compileBase(q, snowflake, [is('REGION', '=', 'EU'), { type: 'or', args: [is('TOTAL', '>=', 50), is('TOTAL', '<', 10)] }])).toBe(
    `select * from (select * from orders) as unfiltered where ("REGION" = 'EU') and (("TOTAL" >= 50) or ("TOTAL" < 10))`,
  )
  expect(compileChart(q, snowflake, baseQueryId).split('\n')[1]).toBe(`from table(result_scan('${baseQueryId}')) as base`)

  expect(compileDrillSnapshot(q, { week: '2026-11-02', weekday: 3 }, baseQueryId, snowflake)).toEqual({
    sql: [
      'select *, row_number() over (order by "TOTAL" desc, "ID") as "__row"',
      `from table(result_scan('${baseQueryId}')) as base`,
      `where date_trunc('week', "PLACED_ON") = ? and extract(dayofweekiso from "PLACED_ON") = ?`,
      'order by "__row"',
      'limit 10001',
    ].join('\n'),
    params: ['2026-11-02', 3],
  })

  expect(compileDrillPage(q, '01b2c3d4-0000-1111-2222-333344445555', 2, snowflake)).toBe(
    [
      'select *',
      `from table(result_scan('01b2c3d4-0000-1111-2222-333344445555'))`,
      'where "__row" > 50 and "__row" <= 75',
      'order by "__row"',
    ].join('\n'),
  )
})

test('identifiers are quoted and string literals escaped for the dialect', () => {
  expect(scalarSql({ type: 'column', name: 'we"ird' }, snowflake)).toBe('"we""ird"')
  expect(scalarSql({ type: 'literal', value: "O'Brien" }, snowflake)).toBe("'O''Brien'")
  // A trailing backslash would otherwise escape the closing quote in Snowflake.
  expect(scalarSql({ type: 'literal', value: 'a\\' }, snowflake)).toBe("'a\\\\'")
  expect(scalarSql({ type: 'literal', value: 'a\\' }, postgres)).toBe("'a\\'")
  expect(
    scalarSql(
      {
        type: 'case',
        cases: [{ when: { type: 'in', arg: col('REGION'), values: ['EU', 'UK'] }, then: { type: 'literal', value: 'Europe' } }],
        else: { type: 'coalesce', args: [col('REGION'), { type: 'literal', value: 'Unknown' }] },
      },
      snowflake,
    ),
  ).toBe(`(case when ("REGION" in ('EU', 'UK')) then 'Europe' else coalesce("REGION", 'Unknown') end)`)
})

test('malformed expressions are rejected', () => {
  expect(() => aggregateSql({ type: 'aggregate', fn: 'sum' }, snowflake)).toThrow('sum requires an argument')
  expect(() => scalarSql({ type: 'literal', value: Number.NaN }, snowflake)).toThrow('Invalid numeric literal')
  expect(() => scalarSql({ type: 'date_trunc', unit: 'day); drop table x; --' as never, arg: col('a') }, snowflake)).toThrow('Unknown time unit')
  expect(() => scalarSql({ type: 'sql', text: 'now()' } as never, snowflake)).toThrow('Unknown expression')
  expect(() => scalarSql({ type: 'in', arg: col('a'), values: [] } as never, snowflake)).toThrow('Unknown expression')
})
