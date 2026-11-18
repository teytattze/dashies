import type { Executor } from '../snowflake/catalog.ts'

/**
 * A sample business domain: one Snowflake table and the rows to fill it with.
 * Seeded into a test schema so charts have realistic data to query.
 */
export type Domain = {
  /** Unquoted, so Snowflake stores it upper-case. */
  table: string
  comment: string
  columns: Column[]
}

export type Column = {
  /** Upper-case; also the key of the value in each `Row`. */
  name: string
  /** Snowflake type, e.g. `number(38,0)`, `timestamp_ntz`. */
  type: string
  nullable?: boolean
  /** Shown to the AI when it reads the catalog. */
  comment: string
}

/** Timestamps and dates are ISO text; Snowflake casts them to the column's type. */
export type Row = Record<string, string | number | boolean | string[] | null>

export type Random = () => number

/** Deterministic random numbers in [0, 1), so the same seed gives the same data (mulberry32). */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!

/** Picks by weight, e.g. `{ done: 6, todo: 1 }` gives `done` six times in seven. */
export function pickWeighted<T extends string>(random: Random, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][]
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0)
  for (const [value, weight] of entries) {
    roll -= weight
    if (roll < 0) return value
  }
  return entries[entries.length - 1]![0]
}

/** `2026-11-02T10:00:00.000`, read by Snowflake as a UTC `timestamp_ntz`. */
export const timestamp = (ms: number) => new Date(ms).toISOString().slice(0, 23)
export const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const DAY_MS = 24 * 60 * 60 * 1000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid Snowflake identifier: ${name}`)
  return name
}

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`

const qualified = (schema: string, domain: Domain) => `${identifier(schema)}.${identifier(domain.table)}`

export function createTableSql(schema: string, domain: Domain): string {
  const columns = domain.columns.map(
    (c) => `  ${identifier(c.name)} ${c.type}${c.nullable ? '' : ' not null'} comment ${quote(c.comment)}`,
  )
  return `create or replace table ${qualified(schema, domain)} (\n${columns.join(',\n')}\n) comment = ${quote(domain.comment)}`
}

/**
 * Inserts a batch bound as one JSON array. The SQL API binds single values
 * only, so this avoids one placeholder per cell.
 */
export function insertSql(schema: string, domain: Domain): string {
  const names = domain.columns.map((c) => identifier(c.name))
  const values = domain.columns.map((c) => `value:"${identifier(c.name)}"::${c.type}`)
  return [
    `insert into ${qualified(schema, domain)} (${names.join(', ')})`,
    `select ${values.join(', ')}`,
    'from table(flatten(input => parse_json(?)))',
  ].join('\n')
}

/** Replaces the domain's table in `schema` with `rows`. Any existing table of that name is dropped. */
export async function load(client: Executor, schema: string, domain: Domain, rows: Row[], batchSize = 1000): Promise<void> {
  const known = new Set(domain.columns.map((c) => c.name))
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`${domain.table} has no column ${key}`)
    for (const c of domain.columns) {
      if (!c.nullable && row[c.name] == null) throw new Error(`${domain.table}.${c.name} is required`)
    }
  }

  await client.execute(createTableSql(schema, domain))
  const insert = insertSql(schema, domain)
  for (let start = 0; start < rows.length; start += batchSize) {
    // A missing key reads as SQL NULL; a JSON null would not for every type.
    const batch = rows
      .slice(start, start + batchSize)
      .map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)))
    await client.execute(insert, [JSON.stringify(batch)], { timeoutSeconds: 120 })
  }
}
