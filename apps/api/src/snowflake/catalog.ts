import type { ColumnType, ResultColumn } from '../db/types.ts'
import { columnType, type SnowflakeClient } from './client.ts'

/** The part of the Snowflake client the catalog needs. */
export type Executor = Pick<SnowflakeClient, 'execute'>

/**
 * Live catalog lookups against the data source's database. Nothing here is
 * stored: the AI calls these while generating, first to find candidate tables
 * and then to read the columns of the ones it picks.
 */

export type CatalogTable = {
  schema: string
  name: string
  kind: 'table' | 'view'
  rowCount: number | null
  comment: string | null
}

export type CatalogColumn = {
  name: string
  type: ColumnType
  /** Snowflake's type name, e.g. `NUMBER`, `TIMESTAMP_NTZ`. */
  nativeType: string
  nullable: boolean
  comment: string | null
}

export type TableRef = { schema: string; name: string }
export type TableColumns = TableRef & { columns: CatalogColumn[] }

const MAX_TABLES = 2000

/** Tables and views in the database, optionally limited to one schema. */
export async function listTables(client: Executor, schema?: string): Promise<CatalogTable[]> {
  const { rows } = await client.execute(
    [
      'select table_schema, table_name, table_type, row_count, comment',
      'from information_schema.tables',
      `where table_schema <> 'INFORMATION_SCHEMA'${schema ? ' and table_schema = ?' : ''}`,
      'order by table_schema, table_name',
    ].join('\n'),
    schema ? [schema] : [],
    { maxRows: MAX_TABLES },
  )
  return rows.map((r) => ({
    schema: r.TABLE_SCHEMA as string,
    name: r.TABLE_NAME as string,
    kind: String(r.TABLE_TYPE).includes('VIEW') ? 'view' : 'table',
    rowCount: (r.ROW_COUNT as number | null) ?? null,
    comment: (r.COMMENT as string | null) || null,
  }))
}

/** Columns of the given tables, in table order. Names are case-sensitive, as `listTables` returns them. */
export async function describeTables(client: Executor, tables: TableRef[]): Promise<TableColumns[]> {
  if (tables.length === 0) return []
  const { rows } = await client.execute(
    [
      'select table_schema, table_name, column_name, data_type, is_nullable, comment',
      'from information_schema.columns',
      `where ${tables.map(() => '(table_schema = ? and table_name = ?)').join(' or ')}`,
      'order by table_schema, table_name, ordinal_position',
    ].join('\n'),
    tables.flatMap((t) => [t.schema, t.name]),
  )

  const byTable = new Map<string, TableColumns>()
  for (const r of rows) {
    const schema = r.TABLE_SCHEMA as string
    const name = r.TABLE_NAME as string
    const key = JSON.stringify([schema, name])
    let table = byTable.get(key)
    if (!table) byTable.set(key, (table = { schema, name, columns: [] }))
    table.columns.push({
      name: r.COLUMN_NAME as string,
      type: columnType(r.DATA_TYPE as string),
      nativeType: r.DATA_TYPE as string,
      nullable: r.IS_NULLABLE === 'YES',
      comment: (r.COMMENT as string | null) || null,
    })
  }
  return [...byTable.values()]
}

/**
 * Columns a query would return, without reading any rows. Used to validate
 * AI-written base SQL and fill `charts.baseColumns`; throws a
 * `SnowflakeError` with the compiler's message if the SQL is invalid.
 */
export async function describeQuery(client: Executor, sql: string): Promise<ResultColumn[]> {
  const { columns } = await client.execute(`select * from (${sql.trim().replace(/;+$/, '')}) as base limit 0`)
  return columns.map(({ name, type }) => ({ name, type }))
}

/**
 * What the AI may do on a data source while generating: look up the catalog
 * and run statements. `SnowflakeClient` wrapped by `explorer` is one.
 */
export type Explorer = Executor & {
  listTables(schema?: string): Promise<CatalogTable[]>
  describeTables(tables: TableRef[]): Promise<TableColumns[]>
}

export function explorer(client: SnowflakeClient): Explorer {
  return {
    execute: (sql, params, options) => client.execute(sql, params, options),
    listTables: (schema) => listTables(client, schema),
    describeTables: (tables) => describeTables(client, tables),
  }
}
