import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ValidationTargets } from 'hono'
import * as z from 'zod'
import { createChartFromPrompt, createThread, type GenerateDeps, getThreadMessages, streamReply } from './ai/generate.ts'
import { getChart, listCharts, listDataSources } from './charts.ts'
import { getFilterOptions, getRun, RunError, startChartRun, startDrillRun } from './runs.ts'

const idParam = z.object({ id: z.uuid() })

/** A dimension value as the chart received it. */
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

const drillRunBody = z.union([
  /**
   * A click on a data point: the chart run's `drillToken` and the chart row.
   * Only the row's dimension values are used.
   */
  z.object({ token: z.uuid(), row: z.record(z.string(), cellValue) }),
  /** Another page of the list that drill run `after` showed. */
  z.object({ after: z.uuid(), page: z.int().min(0) }),
])

/** Option keys to apply, by filter name. A filter left out applies its default; an empty list applies none. */
const chartRunBody = z.object({ filters: z.record(z.string(), z.array(z.string()).max(100)).optional() })

const messageText = z.string().trim().min(1).max(10_000)
const messageBody = z.object({ text: messageText })
const createChartBody = z.object({ dataSourceId: z.uuid(), prompt: messageText })

/** Validates one part of the request, answering 400 with what is wrong. */
const valid = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(target: Target, schema: Schema) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: z.prettifyError(result.error) }, 400)
  })

/**
 * The HTTP API. Runs are asynchronous: a POST starts one and answers 202 at
 * once; the client then polls the run until its status is no longer `running`.
 */
export function createApp(deps: GenerateDeps) {
  return new Hono()
    .get('/api/health', (c) => c.json({ status: 'ok' }))
    /** Starts a run of a chart's aggregated result, narrowed by the filter options picked. */
    .post('/api/charts/:id/runs', valid('param', idParam), async (c) => {
      // The body is optional: without one, every filter applies its default.
      const text = await c.req.text()
      let json: unknown = {}
      if (text.trim() !== '') {
        try {
          json = JSON.parse(text)
        } catch {
          return c.json({ error: 'The body is not valid JSON' }, 400)
        }
      }
      const body = chartRunBody.safeParse(json)
      if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
      return c.json({ run: await startChartRun(deps, c.req.valid('param').id, body.data.filters) }, 202)
    })
    /** Starts a run of one page of the items behind a clicked data point. */
    .post('/api/charts/:id/drill-runs', valid('param', idParam), valid('json', drillRunBody), async (c) => {
      return c.json({ run: await startDrillRun(deps, c.req.valid('param').id, c.req.valid('json')) }, 202)
    })
    /** A run's current state. */
    .get('/api/runs/:id', valid('param', idParam), async (c) => {
      return c.json({ run: await getRun(deps, c.req.valid('param').id) })
    })
    /**
     * Creates a chart from a prompt and streams the AI's reply while it builds
     * it, as an AI SDK UI message stream. The `x-chart-id` and `x-thread-id`
     * response headers name what was created; later messages go to the thread.
     */
    .post('/api/charts', valid('json', createChartBody), (c) => {
      return createChartFromPrompt(deps, c.req.valid('json'))
    })
    /** The Snowflake connections a chart can be built on. */
    .get('/api/data-sources', async (c) => c.json({ dataSources: await listDataSources(deps) }))
    /** Every chart, most recently changed first. */
    .get('/api/charts', async (c) => c.json({ charts: await listCharts(deps) }))
    /** A chart's query and spec, as the AI last left them. */
    .get('/api/charts/:id', valid('param', idParam), async (c) => {
      return c.json({ chart: await getChart(deps, c.req.valid('param').id) })
    })
    /**
     * What a viewer can pick from each lookup filter of the chart, by filter
     * name, read from the warehouse (and remembered for a minute). Filters
     * with written-out options carry them in the chart itself.
     */
    .get('/api/charts/:id/filter-options', valid('param', idParam), async (c) => {
      return c.json({ options: await getFilterOptions(deps, c.req.valid('param').id) })
    })
    /** Starts a chat with the AI about a chart. */
    .post('/api/charts/:id/threads', valid('param', idParam), async (c) => {
      return c.json({ thread: await createThread(deps, c.req.valid('param').id) }, 201)
    })
    /** A thread's messages, in the AI SDK's UI message format. */
    .get('/api/threads/:id/messages', valid('param', idParam), async (c) => {
      return c.json({ messages: await getThreadMessages(deps, c.req.valid('param').id) })
    })
    /**
     * Sends the AI a message and streams its reply as an AI SDK UI message
     * stream. The chart changes while the reply streams: re-read it when a
     * save_chart call finishes, or when the stream ends.
     */
    .post('/api/threads/:id/messages', valid('param', idParam), valid('json', messageBody), (c) => {
      return streamReply(deps, c.req.valid('param').id, c.req.valid('json').text)
    })
    .notFound((c) => c.json({ error: 'Not found' }, 404))
    .onError((error, c) => {
      if (error instanceof RunError) return c.json({ error: error.message }, error.status)
      // Thrown by Hono itself, e.g. for a body that is not valid JSON.
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
      console.error(error)
      return c.json({ error: 'Internal error' }, 500)
    })
}

/** For a typed client in the web app: `hc<App>(baseUrl)`. */
export type App = ReturnType<typeof createApp>
