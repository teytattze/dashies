/**
 * Shapes of the JSONB columns. These are the contract between the AI's tool
 * output, the database and the web renderer, so validate them at the API
 * boundary before writing.
 */

/** Simplified column type, used to pick chart encodings. */
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'timestamp' | 'json' | 'other'

/**
 * Non-secret Snowflake connection settings. The programmatic access token
 * that authenticates lives encrypted in `data_sources.encrypted_credentials`.
 */
export type SnowflakeConfig = {
  /** Account identifier in `orgname-accountname` form, e.g. `myorg-myaccount`. */
  account: string
  warehouse: string
  database: string
  /** Default schema for unqualified table names. */
  schema?: string
  role?: string
}

/**
 * One column of a query's result set. `name` is exactly as Snowflake reports
 * it: unquoted SQL aliases come back upper-case (`select total` -> `TOTAL`).
 */
export type ResultColumn = { name: string; type: ColumnType }

export type Literal = string | number | boolean | null
export type ArithmeticOp = '+' | '-' | '*' | '/'
export type TimeUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
export type DatePart = 'hour' | 'day_of_week' | 'day' | 'month' | 'quarter' | 'year'

/**
 * A per-row expression over the base relation's columns. Stored as a tree, not
 * SQL text, so it can be validated against `baseColumns`, compiled to the
 * warehouse's SQL dialect, and reused verbatim as the drill-down filter.
 */
export type ScalarExpr =
  /** `name` is case-sensitive and must match a `baseColumns` name exactly. */
  | { type: 'column'; name: string }
  | { type: 'literal'; value: Literal }
  /** Start of the hour/day/week/... containing the value. */
  | { type: 'date_trunc'; unit: TimeUnit; arg: ScalarExpr }
  /** A calendar field as a number, e.g. month 1-12. */
  | { type: 'date_part'; part: DatePart; arg: ScalarExpr }
  /** Lower bound of the fixed-width numeric bucket containing the value (histograms). */
  | { type: 'bin'; width: number; arg: ScalarExpr }
  /** `/` is decimal division and yields null when the divisor is zero. */
  | { type: 'arithmetic'; op: ArithmeticOp; left: ScalarExpr; right: ScalarExpr }
  | { type: 'coalesce'; args: ScalarExpr[] }
  | { type: 'case'; cases: { when: Predicate; then: ScalarExpr }[]; else?: ScalarExpr }

export type Predicate =
  | { type: 'compare'; op: '=' | '!=' | '<' | '<=' | '>' | '>='; left: ScalarExpr; right: ScalarExpr }
  | { type: 'in'; arg: ScalarExpr; values: Literal[] }
  | { type: 'is_null'; arg: ScalarExpr }
  | { type: 'and' | 'or'; args: Predicate[] }
  | { type: 'not'; arg: Predicate }

/** An expression over a group of rows: aggregates, optionally combined arithmetically. */
export type AggregateExpr =
  | {
      type: 'aggregate'
      fn: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'
      /** Required except for `count`, where omitting it counts rows. */
      arg?: ScalarExpr
      /** Only aggregate the rows matching this, e.g. revenue from paid orders. */
      where?: Predicate
    }
  | { type: 'literal'; value: number }
  | { type: 'arithmetic'; op: ArithmeticOp; left: AggregateExpr; right: AggregateExpr }

/** What the base rows are grouped by, e.g. `day` = date_trunc(day, created_at). */
export type Dimension = { name: string; expr: ScalarExpr }

/** A value computed per group, e.g. `revenue` = sum(total). */
export type Measure = { name: string; expr: AggregateExpr }

export type OrderBy = { field: string; direction: 'asc' | 'desc' }

/** One choice of a filter: the base rows it keeps. */
export type FilterOption = {
  /** Identifies the option in run requests; unique within its filter. */
  key: string
  label: string
  where: Predicate
}

/**
 * A control a viewer narrows the chart with, e.g. Status: Open / Closed.
 * The picked options choose which base rows are frozen, so the chart and its
 * drill-downs are filtered alike. Picked options of one filter are OR-ed,
 * filters are AND-ed; a filter with nothing picked keeps every row.
 */
export type ChartFilter = FixedFilter | LookupFilter

/** A filter whose options are written into the chart. */
export type FixedFilter = {
  kind?: 'options'
  /** Shown beside the control; unique within the chart. */
  name: string
  options: FilterOption[]
  /** Several options may be picked at once. */
  multi?: boolean
  /** Option keys picked when a run does not say. Omitted = none. */
  default?: string[]
}

/**
 * A filter whose options are the distinct values `expr` has in the chart's
 * base rows, read from the warehouse when the chart is shown, so a new value
 * becomes an option without the chart being saved again. Picking options keeps
 * the base rows where `expr` equals one of them.
 */
export type LookupFilter = {
  kind: 'lookup'
  name: string
  /** The base-row value offered and matched, usually one column. Its text is the option's key and label. */
  expr: ScalarExpr
  multi?: boolean
  /** Keys picked when a run does not say; one the base rows no longer hold is skipped. */
  default?: string[]
}

/** An option of a lookup filter, as last read from the warehouse. */
export type LookupOption = { key: string; label: string; value: string | number | boolean }

/** The option keys picked for each filter of a chart, by filter name. */
export type FilterSelection = Record<string, string[]>

/** The paginated item list shown when a user clicks an aggregated data point. */
export type DrillSpec = {
  /**
   * Base columns that together identify one row. Appended to the sort as a
   * tiebreaker so the order is total and pages never overlap or skip rows.
   */
  rowKey: string[]
  /** Base columns to show, in order. Omitted = all. */
  columns?: string[]
  /** Sort of the item list, by base column. */
  orderBy: OrderBy[]
  pageSize: number
}

export type ValueFormat = {
  style?: 'number' | 'currency' | 'percent' | 'compact'
  currency?: string
  maximumFractionDigits?: number
}

/**
 * How a chart renders its query's rows. Field names refer to `ResultColumn.name`.
 * Aggregation belongs to the query, not here: the spec only maps columns to visuals.
 */
export type ChartSpec =
  | {
      type: 'line' | 'bar' | 'area' | 'scatter'
      x: string
      y: string[]
      /** Column to split into one series per distinct value. */
      series?: string
      stacked?: boolean
      format?: ValueFormat
    }
  | { type: 'pie'; category: string; value: string; format?: ValueFormat }
  | {
      type: 'stat'
      value: string
      /** Column holding the previous-period value, shown as a delta. */
      comparison?: string
      format?: ValueFormat
    }
  | { type: 'table'; columns?: { field: string; label?: string; format?: ValueFormat }[] }

/**
 * A chat message's parts, stored verbatim as the AI SDK's `UIMessage['parts']`
 * (text, reasoning, tool calls with their results), so a thread can be shown
 * again and replayed to the model as-is.
 */
export type MessageContent = Record<string, unknown>[]

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}
