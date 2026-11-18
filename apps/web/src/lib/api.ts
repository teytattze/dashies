import type { UIMessage } from 'ai'
import type { ChartFilter, ChartSpec, FilterSelection, ResultColumn, ValueFormat } from '../../../api/src/db/types.ts'

export type { ChartFilter, ChartSpec, FilterSelection, ResultColumn, ValueFormat }

export type DataSource = { id: string; name: string; kind: string; database: string; schema: string | null }

export type ChartSummary = {
  id: string
  title: string
  dataSourceId: string
  built: boolean
  /** The thread to continue the chat in; null if the chart has none. */
  threadId: string | null
  updatedAt: string
}

export type Chart = {
  id: string
  title: string
  description: string | null
  /** Null until the AI has built the chart. */
  query: { sql: string; dimensions: { name: string }[]; filters: ChartFilter[]; resultColumns: ResultColumn[] | null } | null
  spec: ChartSpec | null
  updatedAt: string
}

export type Row = Record<string, unknown>

export type Run = {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  error: string | null
  columns: ResultColumn[] | null
  rows: Row[] | null
  /** Rows the query produced; more than `rows.length` if the result was capped. */
  rowCount: number | null
  /** The option keys the run applied, for every filter of the chart. Drill runs: those of the chart run drilled into. */
  filters: FilterSelection
  /** Chart runs: starts a drill-down into one of this run's rows. Null if the chart is not drillable. */
  drillToken?: string | null
  /** Drill runs: which page of the clicked point's items this is. */
  drill?: { page: number; pageSize: number; totalItems: number | null; truncated: boolean; hasNextPage: boolean; restarted: boolean }
}

export type DrillRequest =
  /** A click: the chart run's `drillToken` and the clicked row's dimension values. */
  | { token: string; row: Row }
  /** Another page of the list an earlier drill run showed. */
  | { after: string; page: number }

/** The message of an API error body (`{ error }`), or the text as it is. */
export function errorMessage(text: string): string {
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
  } catch {
    // Not JSON.
  }
  return text
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!response.ok) throw new Error(errorMessage(await response.text()) || `Request failed (${response.status})`)
  return (await response.json()) as T
}

export const listDataSources = async () => (await request<{ dataSources: DataSource[] }>('/api/data-sources')).dataSources
export const listCharts = async () => (await request<{ charts: ChartSummary[] }>('/api/charts')).charts
export const getChart = async (id: string) => (await request<{ chart: Chart }>(`/api/charts/${id}`)).chart
export const createThread = async (chartId: string) =>
  (await request<{ thread: { id: string } }>(`/api/charts/${chartId}/threads`, 'POST')).thread.id
export const getMessages = async (threadId: string) =>
  (await request<{ messages: UIMessage[] }>(`/api/threads/${threadId}/messages`)).messages
/** Runs a chart. `filters` picks options by filter name; a filter left out applies its default. */
export const startRun = async (chartId: string, filters?: FilterSelection) =>
  (await request<{ run: Run }>(`/api/charts/${chartId}/runs`, 'POST', filters && { filters })).run
export const getRun = async (id: string) => (await request<{ run: Run }>(`/api/runs/${id}`)).run
export const startDrillRun = async (chartId: string, body: DrillRequest) =>
  (await request<{ run: Run }>(`/api/charts/${chartId}/drill-runs`, 'POST', body)).run

/** Polls a run until it has finished, or until `cancelled` says to give up. */
export async function finished(run: Run, cancelled: () => boolean): Promise<Run> {
  while (run.status === 'running' && !cancelled()) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    run = await getRun(run.id)
  }
  return run
}
