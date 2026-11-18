import { asc, desc, eq, inArray } from 'drizzle-orm'
import * as s from './db/schema.ts'
import { type Database, RunError } from './runs.ts'

type Chart = typeof s.charts.$inferSelect

/** A chart as the API and the AI see it. `query` and `spec` are null until the AI has built it. */
export function chartView(chart: Chart) {
  const { sql, dimensions, measures, orderBy, limit, drill, filters, baseColumns, resultColumns } = chart
  return {
    id: chart.id,
    dataSourceId: chart.dataSourceId,
    title: chart.title,
    description: chart.description,
    query: sql === null ? null : { sql, dimensions, measures, orderBy, limit, drill, filters, baseColumns, resultColumns },
    spec: chart.spec,
    createdAt: chart.createdAt,
    updatedAt: chart.updatedAt,
  }
}

/** A chart with everything needed to render it: run it, then draw the rows as `spec` says. */
export async function getChart({ db }: { db: Database }, chartId: string) {
  const [chart] = await db.select().from(s.charts).where(eq(s.charts.id, chartId))
  if (!chart) throw new RunError(404, 'Chart not found')
  return chartView(chart)
}

/** Every chart, most recently changed first, each with the thread to continue its chat in (null if it has none). */
export async function listCharts({ db }: { db: Database }) {
  const charts = await db.select().from(s.charts).orderBy(desc(s.charts.updatedAt)).limit(200)
  if (charts.length === 0) return []
  const threads = await db
    .select({ id: s.threads.id, chartId: s.threads.chartId })
    .from(s.threads)
    .where(
      inArray(
        s.threads.chartId,
        charts.map((c) => c.id),
      ),
    )
    .orderBy(asc(s.threads.createdAt))
  // Later threads overwrite earlier ones, leaving the newest per chart.
  const latest = new Map(threads.map((t) => [t.chartId, t.id]))
  return charts.map((c) => ({
    id: c.id,
    title: c.title,
    dataSourceId: c.dataSourceId,
    built: c.sql !== null,
    threadId: latest.get(c.id) ?? null,
    updatedAt: c.updatedAt,
  }))
}

/** Every data source, without its credentials. */
export async function listDataSources({ db }: { db: Database }) {
  const sources = await db.select().from(s.dataSources).orderBy(asc(s.dataSources.name))
  return sources.map(({ id, name, kind, config }) => ({ id, name, kind, database: config.database, schema: config.schema ?? null }))
}
