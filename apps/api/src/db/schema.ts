import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  ChartFilter,
  ChartSpec,
  Dimension,
  DrillSpec,
  FilterSelection,
  Measure,
  MessageContent,
  OrderBy,
  ResultColumn,
  SnowflakeConfig,
  TokenUsage,
} from './types.ts'

/**
 * A JSONB column. Drizzle's own hands the driver a JSON string, which Bun's
 * SQL driver encodes once more, storing a JSON string instead of the object
 * or array (and failing checks such as `jsonb_array_length`). Binding the
 * string as text and casting it stores what was meant with every driver.
 */
const jsonb = <T>() =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => 'jsonb',
    toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
    fromDriver: (value) => (typeof value === 'string' ? JSON.parse(value) : value) as T,
  })()

const id = () => uuid().primaryKey().defaultRandom()
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

// ── Tenancy ────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  name: text(),
  createdAt: createdAt(),
})

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  createdAt: createdAt(),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: ['owner', 'editor', 'viewer'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId)],
)

// ── Data sources ───────────────────────────────────────────────────────────

/**
 * A Snowflake connection that charts query. Its catalog (tables, columns)
 * is not stored here: the AI reads it live from Snowflake when generating.
 */
export const dataSources = pgTable(
  'data_sources',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Only Snowflake for now; selects the connector and SQL dialect. */
    kind: text({ enum: ['snowflake'] })
      .notNull()
      .default('snowflake'),
    config: jsonb<SnowflakeConfig>().notNull(),
    /** Programmatic access token of the Snowflake user, encrypted by the app (see `crypto.ts`). Never returned by the API. */
    encryptedCredentials: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.workspaceId, t.name)],
)

// ── Charts ─────────────────────────────────────────────────────────────────

/**
 * A chart over one data source: a query and how its rows are drawn. The row
 * exists from the moment a user starts describing the chart; `sql` and `spec`
 * are null until the AI has built it.
 *
 * `sql` is row-level; `dimensions` and `measures` say how to aggregate it. The
 * server compiles both the chart statement and the drill-down statement from
 * this one definition (see `query/compile.ts`), so the items listed behind a
 * clicked data point are exactly the rows that produced it.
 *
 * With no dimensions and no measures, `sql` runs as-is and cannot be drilled.
 */
export const charts = pgTable(
  'charts',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dataSourceId: uuid()
      .notNull()
      .references(() => dataSources.id, { onDelete: 'restrict' }),
    title: text().notNull().default('Untitled chart'),
    /** What question the chart answers; gives the AI context when editing later. */
    description: text(),
    /** Base relation: one row per item a user would expect to see in a drill-down list. */
    sql: text(),
    dimensions: jsonb<Dimension[]>().notNull().default(sql`'[]'::jsonb`),
    measures: jsonb<Measure[]>().notNull().default(sql`'[]'::jsonb`),
    /** Ordering of the aggregated rows, by dimension/measure name. */
    orderBy: jsonb<OrderBy[]>().notNull().default(sql`'[]'::jsonb`),
    /** Cap on aggregated rows (top-N). */
    limit: integer(),
    /** How the item list behind a data point is shown and paged. Null = not drillable. */
    drill: jsonb<DrillSpec>(),
    /** Controls a viewer narrows the chart with; each run applies the options picked. */
    filters: jsonb().$type<ChartFilter[]>().notNull().default([]),
    /** Columns of `sql`, as the warehouse reported them when the chart was saved. */
    baseColumns: jsonb<ResultColumn[]>(),
    /** Columns the chart draws (dimensions + measures, or `sql`'s own when not aggregated). */
    resultColumns: jsonb<ResultColumn[]>(),
    /** How the result rows are drawn. */
    spec: jsonb<ChartSpec>(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.workspaceId, t.updatedAt),
    index().on(t.dataSourceId),
    // The query and its drawing are saved together.
    check('charts_built_check', sql`(${t.sql} is null) = (${t.spec} is null)`),
    // Drill-down needs an aggregation to drill into.
    check('charts_drill_requires_dimensions_check', sql`${t.drill} is null or jsonb_array_length(${t.dimensions}) > 0`),
    check('charts_limit_check', sql`${t.limit} > 0`),
  ],
)

/** One execution of a chart's query: its aggregated rows, or a page of the items behind a data point. */
export const runs = pgTable(
  'runs',
  {
    id: id(),
    chartId: uuid()
      .notNull()
      .references(() => charts.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['chart', 'drill'] })
      .notNull()
      .default('chart'),
    /** Compiled SQL as executed, since the chart may be edited afterwards. */
    sql: text().notNull(),
    /**
     * Snowflake query ID of the frozen base rows. A chart run of a drillable
     * chart freezes them first and aggregates the frozen copy; drill runs
     * started from that chart run copy the ID and list items from the same
     * copy, so chart and items always agree. Null if nothing was frozen.
     */
    baseQueryId: text(),
    /**
     * The filter options this run's rows were narrowed by. Drill runs copy it
     * from their chart run: the frozen base rows are already filtered.
     */
    filters: jsonb().$type<FilterSelection>().notNull().default({}),
    /** Drill runs: the clicked row's dimension values, by dimension name. */
    drillRow: jsonb<Record<string, unknown>>(),
    /** Drill runs: 0-based page of the item list. */
    page: integer(),
    /**
     * Drill runs: Snowflake query ID of the frozen item list this page is read
     * from, and how many items that list holds. Null while the list is still
     * being frozen. Later pages of the same click copy it from this row; never
     * accept one from a client, since it can read any result the connection's
     * user produced.
     */
    snapshotQueryId: text(),
    snapshotRowCount: integer(),
    /** Drill runs: the data point has more items than the list holds. */
    snapshotTruncated: boolean(),
    /** Drill runs: the list had expired, so it was frozen again and `page` reset to 0. */
    restarted: boolean().notNull().default(false),
    /** Snowflake statement this run is waiting on; null once finished. */
    statementHandle: text(),
    status: text({ enum: ['running', 'succeeded', 'failed'] }).notNull(),
    error: text(),
    rowCount: integer(),
    durationMs: integer(),
    columns: jsonb<ResultColumn[]>(),
    /** Row-capped result, served as cache while fresh. */
    rows: jsonb<Record<string, unknown>[]>(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.chartId, t.startedAt),
    check(
      'runs_drill_check',
      sql`(${t.kind} = 'drill') = (${t.drillRow} is not null) and (${t.kind} = 'drill') = (${t.page} is not null) and ${t.page} >= 0`,
    ),
  ],
)

// ── AI conversation ────────────────────────────────────────────────────────

/** A chat with the AI that creates and then refines one chart. */
export const threads = pgTable(
  'threads',
  {
    id: id(),
    chartId: uuid()
      .notNull()
      .references(() => charts.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.chartId)],
)

export const messages = pgTable(
  'messages',
  {
    id: id(),
    threadId: uuid()
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** 0-based order within the thread. */
    position: integer().notNull(),
    role: text({ enum: ['user', 'assistant'] }).notNull(),
    content: jsonb<MessageContent>().notNull(),
    // Assistant messages only.
    model: text(),
    stopReason: text(),
    usage: jsonb<TokenUsage>(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.threadId, t.position)],
)
