import { beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { simulateReadableStream, type UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { chartView } from '../charts.ts'
import * as s from '../db/schema.ts'
import type { ChartFilter, FixedFilter, LookupFilter, Predicate, ScalarExpr } from '../db/types.ts'
import type { QueryDefinition } from '../query/compile.ts'
import { createApp } from '../http.ts'
import { postgres } from '../query/dialect.ts'
import type { Explorer } from '../snowflake/catalog.ts'
import { SnowflakeError } from '../snowflake/client.ts'
import type { GenerateDeps } from './generate.ts'
import { checkQuery, chartTools } from './tools.ts'

// One in-process Postgres plays both the app's database and the warehouse.
const pg = new PGlite()
const db = drizzle(pg, { schema: s, casing: 'snake_case' })

const explorer: Explorer = {
  async execute(sql) {
    try {
      const { rows, fields } = await pg.query<Record<string, unknown>>(sql)
      const columns = fields.map((f) => ({ name: f.name, type: 'other' as const, nativeType: 'other' }))
      return { queryId: crypto.randomUUID(), columns, rows, totalRows: rows.length }
    } catch (error) {
      throw new SnowflakeError(String(error), 422)
    }
  },
  listTables: async () => [{ schema: 'public', name: 'orders', kind: 'table', rowCount: 9, comment: null }],
  describeTables: async (tables) =>
    tables.map((t) => ({ ...t, columns: [{ name: 'id', type: 'number', nativeType: 'NUMBER', nullable: false, comment: null }] })),
}

/**
 * A model that plays a script: one entry per model call, each either tool
 * calls to make or the text to finish with. An entry may be a function of the
 * result of the previous tool call, to use an ID a tool returned.
 */
type Move = { call: string; input: unknown }[] | string
type Step = Move | ((last: any) => Move)

function scripted(steps: Step[]) {
  let next = 0
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const results = prompt.flatMap((m) => (m.role === 'tool' ? m.content : [])).filter((p) => p.type === 'tool-result')
      const output = results.at(-1)?.output
      const step = steps[next++]
      if (step === undefined) throw new Error('The model was called more often than scripted')
      const move = typeof step === 'function' ? step(output?.type === 'json' ? output.value : undefined) : step
      const finish = (unified: 'stop' | 'tool-calls'): StreamPart => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage })
      const chunks: StreamPart[] =
        typeof move === 'string'
              ? [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: move },
                  { type: 'text-end', id: 't' },
                  finish('stop'),
                ]
              : [
                  ...move.map(({ call, input }, i): StreamPart => ({
                    type: 'tool-call',
                    toolCallId: `call-${next}-${i}`,
                    toolName: call,
                    input: JSON.stringify(input),
                  })),
                  finish('tool-calls'),
                ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  return model
}

const col = (name: string): ScalarExpr => ({ type: 'column', name })
const byRegion: QueryDefinition & { drill: NonNullable<QueryDefinition['drill']> } = {
  sql: 'select * from orders',
  dimensions: [{ name: 'Region', expr: col('region') }],
  measures: [{ name: 'Revenue', expr: { type: 'aggregate', fn: 'sum', arg: col('total') } }],
  orderBy: [{ field: 'Revenue', direction: 'desc' }],
  limit: null,
  drill: { rowKey: ['id'], orderBy: [{ field: 'total', direction: 'desc' }], pageSize: 5 },
  filters: [],
}

let workspaceId: string
let dataSourceId: string

async function setup(steps: Step[]) {
  const [chart] = await db.insert(s.charts).values({ workspaceId, dataSourceId }).returning()
  const model = scripted(steps)
  const deps: GenerateDeps = {
    db,
    dialect: postgres,
    model,
    explore: () => explorer,
    connect: () => {
      throw new Error('not used')
    },
  }
  const app = createApp(deps)
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const created = await call('POST', `/api/charts/${chart!.id}/threads`)
  expect(created.status).toBe(201)
  const threadId = ((await created.json()) as { thread: { id: string } }).thread.id

  /** Sends a message, reads the whole reply stream, and returns the thread as stored afterwards. */
  const send = async (text: string) => {
    const response = await call('POST', `/api/threads/${threadId}/messages`, { text })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBeTruthy()
    const body = await response.text()
    for (let i = 0; i < 100; i++) {
      const stored = await call('GET', `/api/threads/${threadId}/messages`)
      const { messages } = (await stored.json()) as { messages: UIMessage[] }
      if (messages.at(-1)?.role === 'assistant') return { body, messages }
      await Bun.sleep(10)
    }
    throw new Error('The reply was never stored')
  }
  const getChart = async () => {
    const response = await call('GET', `/api/charts/${chart!.id}`)
    return ((await response.json()) as { chart: ReturnType<typeof chartView> }).chart
  }
  return { chartId: chart!.id, threadId, model, call, send, getChart }
}

const toolOutputs = (message: UIMessage) =>
  message.parts.flatMap((p) => (p.type.startsWith('tool-') && 'output' in p ? [p.output as any] : []))

beforeAll(async () => {
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` })
  await pg.exec(`
    create table orders (id int primary key, region text, total int);
    insert into orders select n, 'EU', n * 10 from generate_series(1, 8) n;
    insert into orders values (9, 'US', 500);
  `)
  const [ws] = await db.insert(s.workspaces).values({ name: 'Acme', slug: 'acme-ai' }).returning()
  const [src] = await db
    .insert(s.dataSources)
    .values({ workspaceId: ws!.id, name: 'prod', config: { account: 'a-b', warehouse: 'W', database: 'D' } })
    .returning()
  workspaceId = ws!.id
  dataSourceId = src!.id
})

const barChart = { title: 'Revenue by region', query: { ...byRegion, limit: undefined }, spec: { type: 'bar', x: 'Region', y: ['Revenue'] } }

test('the AI explores the catalog, then builds a chart that is stored and returned', async () => {
  const { send, getChart } = await setup([
    [{ call: 'list_tables', input: {} }],
    [
      { call: 'describe_tables', input: { tables: [{ schema: 'public', name: 'orders' }] } },
      { call: 'sample_rows', input: { sql: 'select distinct region from orders order by 1;' } },
    ],
    [{ call: 'save_chart', input: barChart }],
    'The chart shows revenue by region.',
  ])
  expect(await getChart()).toMatchObject({ title: 'Untitled chart', query: null, spec: null })

  const { body, messages } = await send('Show me revenue by region')
  expect(body).toContain('The chart shows revenue by region.')

  const chart = await getChart()
  expect(chart).toMatchObject({
    title: 'Revenue by region',
    query: { sql: byRegion.sql, dimensions: byRegion.dimensions, drill: byRegion.drill, limit: null },
    spec: { type: 'bar', x: 'Region', y: ['Revenue'] },
  })
  // Filled in by describing the statements on the warehouse.
  expect(chart.query!.baseColumns?.map((c) => c.name)).toEqual(['id', 'region', 'total'])
  expect(chart.query!.resultColumns?.map((c) => c.name)).toEqual(['Region', 'Revenue'])

  // The conversation is stored as UI messages: what the user said, and the reply with every tool call and result.
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'Show me revenue by region' }])
  const outputs = toolOutputs(messages[1]!)
  expect(outputs).toHaveLength(4)
  expect(outputs[2].rows).toEqual([{ region: 'EU' }, { region: 'US' }])
  expect(outputs[3].resultColumns.map((c: { name: string }) => c.name)).toEqual(['Region', 'Revenue'])
})

test('a later message continues the thread: the model is sent the earlier turns and can edit what it built', async () => {
  const { send, getChart, model, threadId } = await setup([
    [{ call: 'save_chart', input: barChart }],
    'Done.',
    [{ call: 'get_chart', input: {} }],
    // Sends back what it read, nulls and reported columns included, with one change.
    (state) => [{ call: 'save_chart', input: { ...state, query: { ...state.query, limit: 1 } } }],
    'Now only the top region.',
  ])
  await send('Revenue by region')
  const { messages } = await send('Only the top region')

  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  const secondTurn = JSON.stringify(model.doStreamCalls[2]!.prompt)
  expect(secondTurn).toContain('Revenue by region')
  expect(secondTurn).toContain('Only the top region')

  const chart = await getChart()
  expect(chart.query!.limit).toBe(1)
  expect(chart.spec).toEqual({ type: 'bar', x: 'Region', y: ['Revenue'] })

  const rows = await db.select().from(s.messages).where(eq(s.messages.threadId, threadId))
  expect(rows.find((r) => r.position === 3)).toMatchObject({ model: 'mock-model-id', stopReason: 'stop' })
  expect(rows.find((r) => r.position === 3)!.usage).toMatchObject({ inputTokens: 30, outputTokens: 15 }) // three model calls
})

test('a chart Snowflake or the model got wrong is reported back to the model and not saved', async () => {
  const { send, getChart } = await setup([
    [
      { call: 'save_chart', input: { ...barChart, query: { sql: 'select * from nowhere' } } },
      { call: 'save_chart', input: { ...barChart, query: { ...barChart.query, dimensions: [{ name: 'Region', expr: col('REGION') }] } } },
      { call: 'save_chart', input: { ...barChart, spec: { type: 'pie', category: 'region', value: 'Revenue' } } },
    ],
    'I could not build that.',
  ])
  const { messages } = await send('Build something')

  const errors = toolOutputs(messages[1]!).map((o) => o.error as string)
  expect(errors[0]).toContain('nowhere')
  expect(errors[1]).toBe('Unknown column in an expression: "REGION". The base SQL returns: "id", "region", "total"')
  expect(errors[2]).toBe('The query does not return "region". It returns: "Region", "Revenue"')
  expect(await getChart()).toMatchObject({ title: 'Untitled chart', query: null, spec: null })
})

test('query definitions are checked before they are stored', async () => {
  const check = (changes: Partial<typeof byRegion>) => checkQuery(explorer, postgres, { ...byRegion, ...changes })

  await expect(check({})).resolves.toMatchObject({ resultColumns: [{ name: 'Region' }, { name: 'Revenue' }] })
  // Plain SQL with no aggregation is allowed, but cannot be drilled into.
  await expect(check({ dimensions: [], measures: [], orderBy: [], drill: undefined })).resolves.toMatchObject({
    resultColumns: [{ name: 'id' }, { name: 'region' }, { name: 'total' }],
  })
  await expect(check({ dimensions: [], measures: [], orderBy: [] })).rejects.toThrow('cannot be drilled into')
  await expect(check({ sql: 'select id, id from orders' })).rejects.toThrow('two columns named "id"')
  await expect(check({ sql: 'delete from orders' })).rejects.toThrow()
  await expect(check({ orderBy: [{ field: 'total', direction: 'asc' }] })).rejects.toThrow('orderBy must name a dimension or measure')
  await expect(check({ drill: { ...byRegion.drill, rowKey: ['order_id'] } })).rejects.toThrow('Unknown column in drill: "order_id"')
  await expect(check({ measures: [{ name: 'Region', expr: { type: 'aggregate', fn: 'count' } }] })).rejects.toThrow('named "Region"')
  // Caught by describing the aggregation: Postgres cannot sum text.
  await expect(check({ measures: [{ name: 'Revenue', expr: { type: 'aggregate', fn: 'sum', arg: col('region') } }] })).rejects.toThrow()
  expect((await pg.query('select count(*)::int as n from orders')).rows).toEqual([{ n: 9 }])
})

test('filters are saved with the chart, and checked against the base columns first', async () => {
  const regionIs = (value: string | number): Predicate => ({ type: 'compare', op: '=', left: col('region'), right: { type: 'literal', value } })
  const region: FixedFilter = {
    name: 'Region',
    options: [
      { key: 'eu', label: 'Europe', where: regionIs('EU') },
      { key: 'us', label: 'United States', where: regionIs('US') },
    ],
    default: ['eu'],
  }
  const { send, getChart } = await setup([
    [{ call: 'save_chart', input: { ...barChart, query: { ...barChart.query, filters: [region] } } }],
    'Added a region filter.',
  ])
  const { messages } = await send('Let me switch between regions')
  expect(toolOutputs(messages[1]!)[0].error).toBeUndefined()
  expect((await getChart()).query!.filters).toEqual([region])

  const check = (filters: ChartFilter[], changes: Partial<typeof byRegion> = {}) =>
    checkQuery(explorer, postgres, { ...byRegion, ...changes, filters })
  const [eu, us] = region.options as [FixedFilter['options'][number], FixedFilter['options'][number]]
  await expect(check([region])).resolves.toMatchObject({ resultColumns: [{ name: 'Region' }, { name: 'Revenue' }] })
  await expect(check([region, { ...region, default: [] }])).rejects.toThrow('Two filters are named "Region"')
  await expect(check([{ ...region, options: [eu, { ...us, key: 'eu' }] }])).rejects.toThrow('two options with the key "eu"')
  await expect(check([{ ...region, default: ['apac'] }])).rejects.toThrow('names options it does not have: "apac"')
  await expect(check([{ ...region, default: ['eu', 'us'] }])).rejects.toThrow('takes one option')
  await expect(check([{ ...region, multi: true, default: ['eu', 'us'] }])).resolves.toBeDefined()
  const unknown: Predicate = { type: 'is_null', arg: col('REGION') }
  await expect(check([{ ...region, options: [{ ...eu, where: unknown }] }])).rejects.toThrow(
    'Unknown column in filter "Region": "REGION". The base SQL returns: "id", "region", "total"',
  )
  // Caught by describing the filtered base: Postgres cannot compare text with a number.
  await expect(check([{ ...region, options: [eu, { ...us, where: regionIs(5) }] }])).rejects.toThrow()
  await expect(check([region], { dimensions: [], measures: [], orderBy: [], drill: undefined })).rejects.toThrow('cannot be filtered')
})

test('a lookup filter is checked against the base rows before it is saved', async () => {
  const region: LookupFilter = { kind: 'lookup', name: 'Region', multi: true, expr: col('region'), default: ['US'] }
  const { send, getChart } = await setup([
    [{ call: 'save_chart', input: { ...barChart, query: { ...barChart.query, filters: [region] } } }],
    'Added a region filter that follows the data.',
  ])
  const { messages } = await send('Filter by region, whatever regions there are')
  expect(toolOutputs(messages[1]!)[0].error).toBeUndefined()
  expect((await getChart()).query!.filters).toEqual([region])

  const check = (changes: Partial<LookupFilter>, sql = byRegion.sql) =>
    checkQuery(explorer, postgres, { ...byRegion, sql, filters: [{ ...region, ...changes }] })
  await expect(check({})).resolves.toBeDefined()
  await expect(check({ expr: col('REGION') })).rejects.toThrow('Unknown column in filter "Region": "REGION". The base SQL returns: "id", "region", "total"')
  await expect(check({ default: ['APAC'] })).rejects.toThrow('names options it does not have: "APAC"')
  await expect(check({ multi: false, default: ['US', 'EU'] })).rejects.toThrow('takes one option')
  // Too many distinct values to offer as options.
  await expect(check({ default: [] }, 'select n as id, n::text as region, n as total from generate_series(1, 101) n')).rejects.toThrow(
    'would offer more than 100 options',
  )
  // No rows yet: nothing to pick so far, but the filter is fine.
  await expect(check({ default: [] }, 'select * from orders where false')).resolves.toBeDefined()
})

test('the tools only change their own chart', async () => {
  const mine = await setup([])
  const other = await setup([])
  const tools = chartTools({ db, dialect: postgres, explorer, chartId: mine.chartId })
  const run = (name: keyof typeof tools, input: unknown): Promise<any> => (tools[name].execute as any)(input, { toolCallId: 'call', messages: [] })

  expect(await run('get_chart', {})).toEqual({ title: 'Untitled chart', description: null, query: null, spec: null })
  await run('save_chart', { ...barChart, query: { ...byRegion, limit: null } })
  // A plain-SQL chart draws the SQL's own columns.
  expect(await run('save_chart', { title: 'Orders', query: { sql: 'select id, total from orders', dimensions: [], measures: [], orderBy: [] }, spec: { type: 'table' } })).toMatchObject({
    resultColumns: [{ name: 'id' }, { name: 'total' }],
  })

  expect(await mine.getChart()).toMatchObject({ title: 'Orders', query: { dimensions: [], drill: null }, spec: { type: 'table' } })
  expect(await other.getChart()).toMatchObject({ title: 'Untitled chart', query: null })
})

test('a prompt creates a chart and a thread, and the reply builds the chart', async () => {
  const { call } = await setup([[{ call: 'save_chart', input: barChart }], 'The chart shows revenue by region.'])

  const response = await call('POST', '/api/charts', { dataSourceId, prompt: 'Show me revenue by region' })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBeTruthy()
  const chartId = response.headers.get('x-chart-id')!
  const threadId = response.headers.get('x-thread-id')!
  expect(await response.text()).toContain('The chart shows revenue by region.')

  const [chart] = await db.select().from(s.charts).where(eq(s.charts.id, chartId))
  expect(chart).toMatchObject({ workspaceId, dataSourceId, title: 'Revenue by region', sql: byRegion.sql })

  // The thread starts with the prompt, so a later message continues from it.
  const stored = await call('GET', `/api/threads/${threadId}/messages`)
  const { messages } = (await stored.json()) as { messages: UIMessage[] }
  expect(messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Show me revenue by region' }] })
})

test('a chart is not created when the request is bad or the data source cannot be opened', async () => {
  const { call } = await setup([])
  const count = () => db.$count(s.charts)
  const before = await count()

  expect((await call('POST', '/api/charts', { dataSourceId: crypto.randomUUID(), prompt: 'hi' })).status).toBe(404)
  expect((await call('POST', '/api/charts', { dataSourceId, prompt: ' ' })).status).toBe(400)
  expect((await call('POST', '/api/charts', { prompt: 'hi' })).status).toBe(400)
  expect(await count()).toBe(before)

  const failing = createApp({
    db,
    dialect: postgres,
    model: scripted([]),
    explore: () => {
      throw new SnowflakeError('Incorrect username or password', 401)
    },
    connect: () => {
      throw new Error('not used')
    },
  })
  const error = console.error
  console.error = () => {}
  try {
    const response = await failing.request('/api/charts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataSourceId, prompt: 'hi' }),
    })
    expect(response.status).toBe(500)
  } finally {
    console.error = error
  }
  expect(await count()).toBe(before)
})

test('bad requests are refused', async () => {
  const { call, threadId } = await setup([])
  const missing = crypto.randomUUID()
  expect((await call('POST', `/api/charts/${missing}/threads`)).status).toBe(404)
  expect((await call('POST', `/api/threads/${missing}/messages`, { text: 'hi' })).status).toBe(404)
  expect((await call('GET', `/api/threads/${missing}/messages`)).status).toBe(404)
  expect((await call('GET', `/api/charts/${missing}`)).status).toBe(404)
  expect((await call('POST', `/api/threads/${threadId}/messages`, { text: '  ' })).status).toBe(400)
  expect((await call('POST', `/api/threads/${threadId}/messages`, {})).status).toBe(400)
})

test('charts are listed newest first with their latest thread, and data sources without credentials', async () => {
  const { call, chartId, threadId } = await setup([])
  const later = await call('POST', `/api/charts/${chartId}/threads`)
  const latest = ((await later.json()) as { thread: { id: string } }).thread.id
  expect(latest).not.toBe(threadId)

  const { charts } = (await (await call('GET', '/api/charts')).json()) as { charts: Record<string, unknown>[] }
  expect(charts[0]).toMatchObject({ id: chartId, title: 'Untitled chart', built: false, threadId: latest, dataSourceId })

  const listed = await call('GET', '/api/data-sources')
  const { dataSources } = (await listed.json()) as { dataSources: Record<string, unknown>[] }
  expect(dataSources.find((d) => d.id === dataSourceId)).toMatchObject({ kind: 'snowflake' })
  expect(JSON.stringify(dataSources)).not.toContain('redentials')
})
