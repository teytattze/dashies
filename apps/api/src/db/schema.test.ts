import { beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as s from './schema.ts'

const db = drizzle(new PGlite(), { schema: s, casing: 'snake_case' })

async function one<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows
  if (!row) throw new Error('expected a row')
  return row
}

/** The constraint a rejected write broke. Drizzle wraps the driver error; the name is on the cause. */
const rejection = (write: PromiseLike<unknown>) =>
  write.then(
    () => '',
    (e: Error) => String(e.cause),
  )

async function seed() {
  const ws = await one(db.insert(s.workspaces).values({ name: 'Acme', slug: crypto.randomUUID() }).returning())
  const src = await one(
    db
      .insert(s.dataSources)
      .values({
        workspaceId: ws.id,
        name: 'prod',
        config: { account: 'acme-prod', warehouse: 'BI_WH', database: 'ANALYTICS' },
      })
      .returning(),
  )
  return { workspaceId: ws.id, dataSourceId: src.id }
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
})

test('a generated chart round-trips: query, spec, runs, thread', async () => {
  const ids = await seed()

  // The chart exists, empty, before the AI builds it.
  const empty = await one(db.insert(s.charts).values(ids).returning())
  expect(empty).toMatchObject({ title: 'Untitled chart', sql: null, spec: null, dimensions: [] })

  const chart = await one(
    db
      .update(s.charts)
      .set({
        title: 'Revenue',
        sql: 'select id, created_at, total from orders',
        baseColumns: [
          { name: 'ID', type: 'number' },
          { name: 'CREATED_AT', type: 'timestamp' },
          { name: 'TOTAL', type: 'number' },
        ],
        dimensions: [{ name: 'day', expr: { type: 'date_trunc', unit: 'day', arg: { type: 'column', name: 'CREATED_AT' } } }],
        measures: [{ name: 'revenue', expr: { type: 'aggregate', fn: 'sum', arg: { type: 'column', name: 'TOTAL' } } }],
        drill: { rowKey: ['ID'], orderBy: [{ field: 'CREATED_AT', direction: 'desc' }], pageSize: 50 },
        resultColumns: [
          { name: 'day', type: 'date' },
          { name: 'revenue', type: 'number' },
        ],
        spec: { type: 'line', x: 'day', y: ['revenue'] },
      })
      .where(eq(s.charts.id, empty.id))
      .returning(),
  )
  expect(chart.spec?.type).toBe('line')

  await db.insert(s.runs).values([
    { chartId: chart.id, sql: 'select ...', status: 'succeeded', rowCount: 0, rows: [] },
    { chartId: chart.id, kind: 'drill', sql: 'select ...', status: 'succeeded', drillRow: { day: '2026-11-01' }, page: 0 },
  ])
  const thread = await one(db.insert(s.threads).values({ chartId: chart.id }).returning())
  await db.insert(s.messages).values({
    threadId: thread.id,
    position: 0,
    role: 'user',
    content: [{ type: 'text', text: 'Show me revenue over time' }],
  })
})

test('deleting a chart removes its runs and threads but keeps the data source', async () => {
  const ids = await seed()
  const chart = await one(db.insert(s.charts).values({ ...ids, sql: 'select 1', spec: { type: 'table' } }).returning())
  await db.insert(s.runs).values({ chartId: chart.id, sql: 'select 1', status: 'running' })
  await db.insert(s.threads).values({ chartId: chart.id })

  await db.delete(s.charts).where(eq(s.charts.id, chart.id))

  expect(await db.select().from(s.runs).where(eq(s.runs.chartId, chart.id))).toEqual([])
  expect(await db.select().from(s.threads).where(eq(s.threads.chartId, chart.id))).toEqual([])
  expect(await db.select().from(s.dataSources).where(eq(s.dataSources.id, ids.dataSourceId))).toHaveLength(1)
})

test('a chart has a query and a spec, or neither', async () => {
  const ids = await seed()
  expect(await rejection(db.insert(s.charts).values({ ...ids, sql: 'select 1' }))).toContain('charts_built_check')
  expect(await rejection(db.insert(s.charts).values({ ...ids, spec: { type: 'table' } }))).toContain('charts_built_check')
})

test('a chart without dimensions cannot be drillable', async () => {
  const ids = await seed()
  const insert = db
    .insert(s.charts)
    .values({ ...ids, sql: 'select 1', spec: { type: 'table' }, drill: { rowKey: ['id'], orderBy: [], pageSize: 50 } })
  expect(await rejection(insert)).toContain('charts_drill_requires_dimensions_check')
})
