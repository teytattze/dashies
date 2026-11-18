import { expect, test } from 'bun:test'
import { decryptSecret, encryptSecret } from '../crypto.ts'
import { describeQuery, describeTables, listTables } from './catalog.ts'
import { SnowflakeClient, SnowflakeError } from './client.ts'

const token = 'pat-test-token'

type Call = { method: string; url: string; headers: Record<string, string>; body?: Record<string, any> }
type Reply = { status?: number; body: unknown }

/** A client whose HTTP calls are answered, in order, from `replies`. */
function fakeSnowflake(replies: Reply[]) {
  const calls: Call[] = []
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected request: ${String(url)}`)
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  const client = new SnowflakeClient({
    config: { account: 'acme-prod', warehouse: 'BI_WH', database: 'ANALYTICS', role: 'REPORTER' },
    token,
    fetch: fakeFetch as typeof fetch,
    sleep: async () => {},
  })
  return { client, calls }
}

const result = (rowType: { name: string; type: string; scale?: number }[], data: (string | null)[][], extra = {}) => ({
  body: { statementHandle: 'h1', resultSetMetaData: { numRows: data.length, rowType, partitionInfo: [{ rowCount: data.length }], ...extra }, data },
})

test('execute sends the statement with bindings, session context and the access token', async () => {
  const { client, calls } = fakeSnowflake([result([{ name: 'N', type: 'fixed', scale: 0 }], [['1']])])
  await client.execute('select ? as n, ?, ?, ?', ['EU', 3, 1.5, true], { timeoutSeconds: 30 })

  const call = calls[0]!
  expect(call.method).toBe('POST')
  expect(call.url).toStartWith('https://acme-prod.snowflakecomputing.com/api/v2/statements?requestId=')
  expect(call.body).toMatchObject({
    statement: 'select ? as n, ?, ?, ?',
    timeout: 30,
    warehouse: 'BI_WH',
    database: 'ANALYTICS',
    role: 'REPORTER',
    bindings: {
      '1': { type: 'TEXT', value: 'EU' },
      '2': { type: 'FIXED', value: '3' },
      '3': { type: 'REAL', value: '1.5' },
      '4': { type: 'BOOLEAN', value: 'true' },
    },
    parameters: { timezone: 'UTC', date_output_format: 'YYYY-MM-DD' },
  })

  expect(call.headers['X-Snowflake-Authorization-Token-Type']).toBe('PROGRAMMATIC_ACCESS_TOKEN')
  expect(call.headers.Authorization).toBe(`Bearer ${token}`)
})

test('execute decodes values by column type', async () => {
  const { client } = fakeSnowflake([
    result(
      [
        { name: 'ID', type: 'fixed', scale: 0 },
        { name: 'TOTAL', type: 'fixed', scale: 2 },
        { name: 'BIG', type: 'fixed', scale: 0 },
        { name: 'RATIO', type: 'real' },
        { name: 'NAME', type: 'text' },
        { name: 'PAID', type: 'boolean' },
        { name: 'DAY', type: 'date' },
        { name: 'AT', type: 'timestamp_ntz' },
        { name: 'TAGS', type: 'array' },
        { name: 'MISSING', type: 'text' },
      ],
      [['7', '19.99', '12345678901234567890', '0.25', 'Ada', 'true', '2026-11-02', '2026-11-02T10:00:00.000000000', '["a","b"]', null]],
    ),
  ])
  const { columns, rows, totalRows } = await client.execute('select ...')

  expect(rows).toEqual([
    {
      ID: 7,
      TOTAL: 19.99,
      BIG: '12345678901234567890',
      RATIO: 0.25,
      NAME: 'Ada',
      PAID: true,
      DAY: '2026-11-02',
      AT: '2026-11-02T10:00:00.000000000',
      TAGS: ['a', 'b'],
      MISSING: null,
    },
  ])
  expect(totalRows).toBe(1)
  expect(columns.map((c) => c.type)).toEqual(['number', 'number', 'number', 'number', 'string', 'boolean', 'date', 'timestamp', 'json', 'string'])
  expect(columns[7]).toEqual({ name: 'AT', type: 'timestamp', nativeType: 'timestamp_ntz' })
})

test('execute polls a statement that is still running', async () => {
  const { client, calls } = fakeSnowflake([
    { status: 202, body: { code: '333334', statementHandle: 'h1' } },
    { status: 202, body: { code: '333334', statementHandle: 'h1' } },
    result([{ name: 'N', type: 'fixed', scale: 0 }], [['1']]),
  ])
  expect((await client.execute('select 1')).rows).toEqual([{ N: 1 }])
  expect(calls.slice(1).map((c) => [c.method, c.url])).toEqual([
    ['GET', 'https://acme-prod.snowflakecomputing.com/api/v2/statements/h1'],
    ['GET', 'https://acme-prod.snowflakecomputing.com/api/v2/statements/h1'],
  ])
})

test('execute reads further partitions only until maxRows is reached', async () => {
  const partitioned = () =>
    result([{ name: 'N', type: 'fixed', scale: 0 }], [['1'], ['2']], {
      numRows: 6,
      partitionInfo: [{ rowCount: 2 }, { rowCount: 2 }, { rowCount: 2 }],
    })

  const all = fakeSnowflake([partitioned(), { body: { data: [['3'], ['4']] } }, { body: { data: [['5'], ['6']] } }])
  expect((await all.client.execute('select ...')).rows.map((r) => r.N)).toEqual([1, 2, 3, 4, 5, 6])
  expect(all.calls[2]!.url).toEndWith('/statements/h1?partition=2')

  const capped = fakeSnowflake([partitioned(), { body: { data: [['3'], ['4']] } }])
  const { rows, totalRows } = await capped.client.execute('select ...', [], { maxRows: 3 })
  expect(rows.map((r) => r.N)).toEqual([1, 2, 3])
  expect(totalRows).toBe(6)
  expect(capped.calls).toHaveLength(2)
})

test('a failed statement throws with Snowflake’s message, code and SQLSTATE', async () => {
  const { client } = fakeSnowflake([
    { status: 422, body: { code: '002003', sqlState: '42S02', message: "SQL compilation error: Object 'ORDERZ' does not exist.", statementHandle: 'h1' } },
  ])
  const error = await client.execute('select * from orderz').catch((e) => e)
  expect(error).toBeInstanceOf(SnowflakeError)
  expect(error).toMatchObject({ status: 422, code: '002003', sqlState: '42S02' })
  expect(error.message).toContain("Object 'ORDERZ' does not exist")
})

test('listTables and describeTables read the live catalog', async () => {
  const text = (name: string) => ({ name, type: 'text' })
  const { client, calls } = fakeSnowflake([
    result(
      [text('TABLE_SCHEMA'), text('TABLE_NAME'), text('TABLE_TYPE'), { name: 'ROW_COUNT', type: 'fixed', scale: 0 }, text('COMMENT')],
      [
        ['SALES', 'ORDERS', 'BASE TABLE', '1200', 'One row per order'],
        ['SALES', 'ORDER_SUMMARY', 'VIEW', null, null],
      ],
    ),
    result(
      [text('TABLE_SCHEMA'), text('TABLE_NAME'), text('COLUMN_NAME'), text('DATA_TYPE'), text('IS_NULLABLE'), text('COMMENT')],
      [
        ['SALES', 'ORDERS', 'ID', 'NUMBER', 'NO', null],
        ['SALES', 'ORDERS', 'PLACED_AT', 'TIMESTAMP_NTZ', 'YES', 'UTC'],
      ],
    ),
  ])

  expect(await listTables(client, 'SALES')).toEqual([
    { schema: 'SALES', name: 'ORDERS', kind: 'table', rowCount: 1200, comment: 'One row per order' },
    { schema: 'SALES', name: 'ORDER_SUMMARY', kind: 'view', rowCount: null, comment: null },
  ])
  expect(calls[0]!.body!.bindings).toEqual({ '1': { type: 'TEXT', value: 'SALES' } })

  expect(await describeTables(client, [{ schema: 'SALES', name: 'ORDERS' }])).toEqual([
    {
      schema: 'SALES',
      name: 'ORDERS',
      columns: [
        { name: 'ID', type: 'number', nativeType: 'NUMBER', nullable: false, comment: null },
        { name: 'PLACED_AT', type: 'timestamp', nativeType: 'TIMESTAMP_NTZ', nullable: true, comment: 'UTC' },
      ],
    },
  ])
  // Table names are bound, never spliced into the SQL.
  expect(calls[1]!.body!.statement).not.toContain('ORDERS')
  expect(calls[1]!.body!.bindings).toEqual({ '1': { type: 'TEXT', value: 'SALES' }, '2': { type: 'TEXT', value: 'ORDERS' } })
})

test('describeQuery returns a query’s columns without reading rows', async () => {
  const { client, calls } = fakeSnowflake([result([{ name: 'ID', type: 'fixed', scale: 0 }, { name: 'REGION', type: 'text' }], [])])
  expect(await describeQuery(client, 'select id, region from orders;')).toEqual([
    { name: 'ID', type: 'number' },
    { name: 'REGION', type: 'string' },
  ])
  expect(calls[0]!.body!.statement).toBe('select * from (select id, region from orders) as base limit 0')
})

test('submit starts a statement without waiting and poll reads it once finished', async () => {
  const { client, calls } = fakeSnowflake([
    { status: 202, body: { code: '333334', statementHandle: 'h1' } },
    { status: 202, body: { code: '333334', statementHandle: 'h1' } },
    result([{ name: 'N', type: 'fixed', scale: 0 }], [['1'], ['2']]),
    { status: 422, body: { code: '002003', sqlState: '42S02', message: 'Object does not exist.', statementHandle: 'h2' } },
  ])

  expect(await client.submit('select ?', ['x'])).toBe('h1')
  expect(calls[0]!.url).toContain('&async=true')
  expect(calls[0]!.body!.bindings).toEqual({ '1': { type: 'TEXT', value: 'x' } })

  expect(await client.poll('h1')).toBeNull()
  const done = await client.poll('h1', { maxRows: 1 })
  expect(calls[2]!.url).toEndWith('/statements/h1')
  expect(done).toMatchObject({ queryId: 'h1', rows: [{ N: 1 }], totalRows: 2 })

  const error = await client.poll('h2').then(() => null, (e: SnowflakeError) => e)
  expect(error).toMatchObject({ status: 422, code: '002003' })
  await expect(client.poll('../x')).rejects.toThrow('Invalid statement handle')

  // A result that result_scan will read keeps Snowflake's default encoding of dates and times.
  expect(calls[0]!.body!.parameters).toHaveProperty('timestamp_ntz_output_format')
  await client.submit('select 1', [], { forResultScan: true }).catch(() => {})
  expect(calls.at(-1)!.body!.parameters).toEqual({ timezone: 'UTC' })
})

test('stored credentials round-trip through encryption', async () => {
  process.env.CREDENTIALS_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const encrypted = await encryptSecret(token)
  expect(encrypted).not.toContain(token)
  expect(await encryptSecret(token)).not.toBe(encrypted)
  expect(await decryptSecret(encrypted)).toBe(token)

  process.env.CREDENTIALS_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  await expect(decryptSecret(encrypted)).rejects.toThrow()
})
