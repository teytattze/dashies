import type { ColumnType, ResultColumn, SnowflakeConfig } from '../db/types.ts'

/**
 * Minimal client for the Snowflake SQL API (`/api/v2/statements`) with
 * a programmatic access token. Plain `fetch`, no driver.
 * https://docs.snowflake.com/en/developer-guide/sql-api/index
 */

export type SnowflakeColumn = ResultColumn & {
  /** Snowflake's own type name, lower-cased, e.g. `fixed`, `timestamp_ntz`. */
  nativeType: string
}

export type QueryResult = {
  /** Snowflake's ID for the statement. Its result can be re-read with RESULT_SCAN for 24 hours. */
  queryId: string
  columns: SnowflakeColumn[]
  rows: Record<string, unknown>[]
  /** Rows the statement produced; more than `rows.length` when `maxRows` cut it short. */
  totalRows: number
}

export type ExecuteOptions = {
  /** Stop reading after this many rows. */
  maxRows?: number
  /** Seconds before Snowflake cancels the statement. */
  timeoutSeconds?: number
}

export type SnowflakeClientOptions = {
  config: SnowflakeConfig
  /** Programmatic access token of the Snowflake user. */
  token: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export class SnowflakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Snowflake error code and SQLSTATE, when the statement itself failed. */
    readonly code?: string,
    readonly sqlState?: string,
  ) {
    super(message)
    this.name = 'SnowflakeError'
  }
}

type RowType = { name: string; type: string; scale?: number | null }
type StatementResponse = {
  code?: string
  sqlState?: string
  message?: string
  statementHandle?: string
  resultSetMetaData?: { numRows: number; rowType: RowType[]; partitionInfo?: { rowCount: number }[] }
  data?: (string | null)[][]
}

// By default dates and times come back as epoch numbers whose encoding varies
// by type. Asking for ISO text instead makes values unambiguous, and lets a
// clicked value be bound straight back as text in a drill-down filter.
const OUTPUT_FORMATS = {
  timezone: 'UTC',
  date_output_format: 'YYYY-MM-DD',
  time_output_format: 'HH24:MI:SS.FF9',
  timestamp_ntz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9',
  timestamp_ltz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM',
  timestamp_tz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM',
}

/** Maps a Snowflake type name (from result metadata or INFORMATION_SCHEMA) to ours. */
export function columnType(snowflakeType: string): ColumnType {
  const t = snowflakeType.toLowerCase()
  if (['fixed', 'number', 'real', 'float', 'decfloat'].includes(t)) return 'number'
  if (['text', 'varchar'].includes(t)) return 'string'
  if (t === 'boolean') return 'boolean'
  if (t === 'date') return 'date'
  if (t.startsWith('timestamp')) return 'timestamp'
  if (['variant', 'object', 'array'].includes(t)) return 'json'
  return 'other'
}

function decode(value: string | null, column: RowType): unknown {
  if (value === null) return null
  switch (columnType(column.type)) {
    case 'number': {
      const n = Number(value)
      // Keep integers too large for a double as text rather than corrupt them.
      return Number.isInteger(n) && !Number.isSafeInteger(n) ? value : n
    }
    case 'boolean':
      return value === 'true'
    case 'json':
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    default:
      return value
  }
}

function binding(value: unknown): { type: string; value: string } {
  if (typeof value === 'string') return { type: 'TEXT', value }
  if (typeof value === 'boolean') return { type: 'BOOLEAN', value: String(value) }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { type: Number.isInteger(value) ? 'FIXED' : 'REAL', value: String(value) }
  }
  throw new Error(`Cannot bind value: ${JSON.stringify(value)}`)
}

export type SubmitOptions = Pick<ExecuteOptions, 'timeoutSeconds'> & {
  /**
   * The result will be read by later statements through `result_scan`, not
   * fetched. It is then stored in Snowflake's default encoding: `result_scan`
   * cannot read back dates and times that were formatted as text.
   */
  forResultScan?: boolean
}

export class SnowflakeClient {
  readonly config: SnowflakeConfig
  private readonly token: string
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly baseUrl: string

  constructor(options: SnowflakeClientOptions) {
    this.config = options.config
    this.token = options.token.trim()
    if (!this.token) throw new Error('Snowflake access token is empty')
    this.fetch = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    if (!/^[\w.-]+$/.test(this.config.account)) throw new Error(`Invalid Snowflake account: ${this.config.account}`)
    this.baseUrl = `https://${this.config.account}.snowflakecomputing.com/api/v2/statements`
  }

  /** Runs one statement, with `?` placeholders bound to `params`, and reads its rows. */
  async execute(sql: string, params: unknown[] = [], options: ExecuteOptions = {}): Promise<QueryResult> {
    let response = await this.post(sql, params, options, false)
    // 202 = still running. While polling, Snowflake may also answer 429 for the same reason.
    let body = await this.body(response)
    for (let delay = 250; response.status === 202 || (response.status === 429 && body.statementHandle); ) {
      if (!body.statementHandle) throw new SnowflakeError('Snowflake returned no statement handle', response.status)
      await this.sleep(delay)
      delay = Math.min(delay * 2, 4000)
      response = await this.request(`${this.baseUrl}/${body.statementHandle}`)
      body = await this.body(response)
    }
    return this.read(response, body, options)
  }

  /**
   * Starts a statement without waiting for it and returns its handle, which is
   * also its Snowflake query ID. Follow it with `poll`.
   */
  async submit(sql: string, params: unknown[] = [], options: SubmitOptions = {}): Promise<string> {
    const response = await this.post(sql, params, options, true)
    const body = await this.body(response)
    if ((response.status !== 200 && response.status !== 202) || !body.statementHandle) throw this.failure(response, body)
    return body.statementHandle
  }

  /** Result of a submitted statement, or null while it is still running. Throws if it failed. */
  async poll(handle: string, options: Pick<ExecuteOptions, 'maxRows'> = {}): Promise<QueryResult | null> {
    if (!/^[\w-]+$/.test(handle)) throw new Error(`Invalid statement handle: ${handle}`)
    const response = await this.request(`${this.baseUrl}/${handle}`)
    const body = await this.body(response)
    if (response.status === 202 || response.status === 429) return null
    return this.read(response, body, options)
  }

  private post(sql: string, params: unknown[], options: ExecuteOptions & SubmitOptions, async: boolean): Promise<Response> {
    const { config } = this
    return this.request(`${this.baseUrl}?requestId=${crypto.randomUUID()}${async ? '&async=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify({
        statement: sql,
        timeout: options.timeoutSeconds ?? 60,
        warehouse: config.warehouse,
        database: config.database,
        schema: config.schema,
        role: config.role,
        bindings: Object.fromEntries(params.map((p, i) => [String(i + 1), binding(p)])),
        parameters: options.forResultScan ? { timezone: OUTPUT_FORMATS.timezone } : OUTPUT_FORMATS,
      }),
    })
  }

  private failure(response: Response, body: StatementResponse): SnowflakeError {
    return new SnowflakeError(body.message ?? `Snowflake request failed (${response.status})`, response.status, body.code, body.sqlState)
  }

  /** Reads a finished statement's rows, fetching further partitions as needed. */
  private async read(response: Response, body: StatementResponse, options: Pick<ExecuteOptions, 'maxRows'>): Promise<QueryResult> {
    if (response.status !== 200 || !body.resultSetMetaData) throw this.failure(response, body)
    const meta = body.resultSetMetaData
    if (!body.statementHandle) throw new SnowflakeError('Snowflake returned no statement handle', response.status)
    const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
    const data = body.data ?? []
    // Large results are split into partitions; the first arrives with the response.
    const partitions = meta.partitionInfo?.length ?? 1
    for (let partition = 1; partition < partitions && data.length < maxRows; partition++) {
      const next = await this.request(`${this.baseUrl}/${body.statementHandle}?partition=${partition}`)
      const nextBody = await this.body(next)
      if (next.status !== 200) throw this.failure(next, nextBody)
      data.push(...(nextBody.data ?? []))
    }

    const rowType = meta.rowType
    return {
      queryId: body.statementHandle,
      columns: rowType.map((c) => ({ name: c.name, type: columnType(c.type), nativeType: c.type.toLowerCase() })),
      rows: data
        .slice(0, maxRows)
        .map((row) => Object.fromEntries(rowType.map((c, i) => [c.name, decode(row[i] ?? null, c)]))),
      totalRows: meta.numRows,
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'dashies/0.0.0',
      },
    })
  }

  private async body(response: Response): Promise<StatementResponse> {
    const text = await response.text()
    try {
      return JSON.parse(text) as StatementResponse
    } catch {
      throw new SnowflakeError(`Snowflake returned a non-JSON response (${response.status})`, response.status)
    }
  }
}
