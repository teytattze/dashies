import * as z from 'zod'
import type { AggregateExpr, ChartFilter, ChartSpec, Dimension, DrillSpec, Measure, OrderBy, Predicate, ScalarExpr } from '../db/types.ts'

/**
 * Runtime schemas for the JSON the AI writes (see `db/types.ts` for what each
 * shape means). They are the input schemas of the AI's tools, so the model
 * sees their descriptions and its output is validated against them before
 * anything is stored.
 */

const literal = z.union([z.string(), z.number(), z.boolean(), z.null()])
const timeUnit = z.enum(['hour', 'day', 'week', 'month', 'quarter', 'year'])
const datePart = z.enum(['hour', 'day_of_week', 'day', 'month', 'quarter', 'year'])
const arithmeticOp = z.enum(['+', '-', '*', '/'])
const name = z.string().min(1).max(100)

export const scalarExpr: z.ZodType<ScalarExpr> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('column'), name }).describe('A column of the base SQL, named exactly as reported'),
    z.object({ type: z.literal('literal'), value: literal }),
    z.object({ type: z.literal('date_trunc'), unit: timeUnit, arg: scalarExpr }),
    z.object({ type: z.literal('date_part'), part: datePart, arg: scalarExpr }),
    z
      .object({ type: z.literal('bin'), width: z.number().positive(), arg: scalarExpr })
      .describe('Lower bound of the fixed-width numeric bucket containing the value'),
    z.object({ type: z.literal('arithmetic'), op: arithmeticOp, left: scalarExpr, right: scalarExpr }),
    z.object({ type: z.literal('coalesce'), args: z.array(scalarExpr).min(1) }),
    z.object({
      type: z.literal('case'),
      cases: z.array(z.object({ when: predicate, then: scalarExpr })).min(1),
      else: scalarExpr.optional(),
    }),
  ]),
)

export const predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('compare'),
      op: z.enum(['=', '!=', '<', '<=', '>', '>=']),
      left: scalarExpr,
      right: scalarExpr,
    }),
    z.object({ type: z.literal('in'), arg: scalarExpr, values: z.array(literal).min(1) }),
    z.object({ type: z.literal('is_null'), arg: scalarExpr }),
    z.object({ type: z.enum(['and', 'or']), args: z.array(predicate).min(1) }),
    z.object({ type: z.literal('not'), arg: predicate }),
  ]),
)

export const aggregateExpr: z.ZodType<AggregateExpr> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('aggregate'),
      fn: z.enum(['sum', 'avg', 'min', 'max', 'count', 'count_distinct']),
      arg: scalarExpr.optional().describe('Required except for count, where omitting it counts rows'),
      where: predicate.optional().describe('Only aggregate the rows matching this'),
    }),
    z.object({ type: z.literal('literal'), value: z.number() }),
    z.object({ type: z.literal('arithmetic'), op: arithmeticOp, left: aggregateExpr, right: aggregateExpr }),
  ]),
)

export const dimension: z.ZodType<Dimension> = z.object({ name, expr: scalarExpr })
export const measure: z.ZodType<Measure> = z.object({ name, expr: aggregateExpr })
export const orderBy: z.ZodType<OrderBy> = z.object({ field: name, direction: z.enum(['asc', 'desc']) })

export const drillSpec: z.ZodType<DrillSpec> = z.object({
  rowKey: z.array(name).min(1).describe('Base columns that together identify exactly one row'),
  columns: z.array(name).min(1).optional().describe('Base columns to list, in order. Omit for all'),
  orderBy: z.array(orderBy).describe('Sort of the item list, by base column'),
  pageSize: z.int().min(1).max(200),
})

export const chartFilter: z.ZodType<ChartFilter> = z.object({
  name: name.describe('Shown beside the control, e.g. "Status"'),
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(50).describe('Short stable identifier, unique within the filter'),
        label: z.string().min(1).max(100).describe('What the viewer reads'),
        where: predicate.describe('The base rows this option keeps'),
      }),
    )
    .min(1)
    .max(20),
  multi: z.boolean().optional().describe('Several options may be picked at once; rows matching any of them are kept'),
  default: z.array(z.string()).optional().describe('Option keys picked when the chart opens. Omit to start with every row'),
})

const valueFormat = z.object({
  style: z.enum(['number', 'currency', 'percent', 'compact']).optional(),
  currency: z.string().length(3).optional().describe('ISO 4217 code, for the currency style'),
  maximumFractionDigits: z.int().min(0).max(6).optional(),
})

export const chartSpec: z.ZodType<ChartSpec> = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['line', 'bar', 'area', 'scatter']),
    x: name,
    y: z.array(name).min(1),
    series: name.optional().describe('Column to split into one series per distinct value'),
    stacked: z.boolean().optional(),
    format: valueFormat.optional(),
  }),
  z.object({ type: z.literal('pie'), category: name, value: name, format: valueFormat.optional() }),
  z.object({
    type: z.literal('stat'),
    value: name,
    comparison: name.optional().describe('Column holding the previous-period value, shown as a delta'),
    format: valueFormat.optional(),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.object({ field: name, label: z.string().optional(), format: valueFormat.optional() })).optional(),
  }),
])

/** Base columns an expression reads. */
export function scalarColumns(e: ScalarExpr, into = new Set<string>()): Set<string> {
  switch (e.type) {
    case 'column':
      into.add(e.name)
      break
    case 'date_trunc':
    case 'date_part':
    case 'bin':
      scalarColumns(e.arg, into)
      break
    case 'arithmetic':
      scalarColumns(e.left, into)
      scalarColumns(e.right, into)
      break
    case 'coalesce':
      for (const arg of e.args) scalarColumns(arg, into)
      break
    case 'case':
      for (const c of e.cases) {
        predicateColumns(c.when, into)
        scalarColumns(c.then, into)
      }
      if (e.else) scalarColumns(e.else, into)
      break
  }
  return into
}

export function predicateColumns(p: Predicate, into = new Set<string>()): Set<string> {
  switch (p.type) {
    case 'compare':
      scalarColumns(p.left, into)
      scalarColumns(p.right, into)
      break
    case 'in':
    case 'is_null':
      scalarColumns(p.arg, into)
      break
    case 'and':
    case 'or':
      for (const arg of p.args) predicateColumns(arg, into)
      break
    case 'not':
      predicateColumns(p.arg, into)
      break
  }
  return into
}

export function aggregateColumns(e: AggregateExpr, into = new Set<string>()): Set<string> {
  if (e.type === 'aggregate') {
    if (e.arg) scalarColumns(e.arg, into)
    if (e.where) predicateColumns(e.where, into)
  } else if (e.type === 'arithmetic') {
    aggregateColumns(e.left, into)
    aggregateColumns(e.right, into)
  }
  return into
}

/** Result columns a chart reads. */
export function chartFields(spec: ChartSpec): string[] {
  switch (spec.type) {
    case 'pie':
      return [spec.category, spec.value]
    case 'stat':
      return spec.comparison ? [spec.value, spec.comparison] : [spec.value]
    case 'table':
      return spec.columns?.map((c) => c.field) ?? []
    default:
      return spec.series ? [spec.x, ...spec.y, spec.series] : [spec.x, ...spec.y]
  }
}
