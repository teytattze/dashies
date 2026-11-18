/** The places where warehouses disagree on SQL. Everything else the compiler emits is common. */
export type Dialect = {
  /** Bind placeholder for the `index`-th (1-based) parameter. */
  placeholder(index: number): string
  stringLiteral(value: string): string
  /** Decimal division that yields null when the divisor is zero. */
  divide(left: string, right: string): string
  /** `extract` field for ISO day of week (Monday = 1). */
  dayOfWeek: string
  /** Relation holding the stored result of an earlier statement. `queryId` is already validated. */
  resultScan(queryId: string): string
}

/** What charts run on. */
export const snowflake: Dialect = {
  placeholder: () => '?',
  // Backslash is an escape character inside Snowflake string constants.
  stringLiteral: (v) => `'${v.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`,
  // Snowflake division is already decimal.
  divide: (l, r) => `(${l} / nullif(${r}, 0))`,
  dayOfWeek: 'dayofweekiso',
  resultScan: (id) => `table(result_scan('${id}'))`,
}

/**
 * Not a supported data source: exists so the tests can execute compiled SQL
 * against an in-process Postgres and check what it returns.
 */
export const postgres: Dialect = {
  placeholder: (i) => `$${i}`,
  stringLiteral: (v) => `'${v.replaceAll("'", "''")}'`,
  divide: (l, r) => `(${l}::numeric / nullif(${r}, 0))`,
  dayOfWeek: 'isodow',
  // Postgres keeps no results; the tests save the snapshot as a table named after its ID.
  resultScan: (id) => `"${id}"`,
}
