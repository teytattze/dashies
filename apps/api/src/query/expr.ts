import type { AggregateExpr, ArithmeticOp, DatePart, Literal, Predicate, ScalarExpr, TimeUnit } from '../db/types.ts'
import type { Dialect } from './dialect.ts'

/**
 * Compiles expression trees to SQL. The trees come from stored JSON (written
 * by the AI), so anything unrecognised throws rather than reaching the SQL:
 * every enum-like field is looked up in a table, never interpolated.
 */

const ARITHMETIC_OPS: ReadonlySet<string> = new Set<ArithmeticOp>(['+', '-', '*', '/'])
const COMPARE_OPS: Record<string, string> = { '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }
const TIME_UNITS: ReadonlySet<string> = new Set<TimeUnit>(['hour', 'day', 'week', 'month', 'quarter', 'year'])
const DATE_PARTS: ReadonlySet<string> = new Set<DatePart>(['hour', 'day_of_week', 'day', 'month', 'quarter', 'year'])
const AGGREGATES = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', count: 'count', count_distinct: 'count' }

/** Quoted, so case-sensitive: the name must match the column exactly as the warehouse reports it. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

function number(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid numeric literal: ${value}`)
  return String(value)
}

function literal(value: Literal, d: Dialect): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return number(value)
  if (typeof value === 'string') return d.stringLiteral(value)
  throw new Error(`Invalid literal: ${JSON.stringify(value)}`)
}

function nonEmpty<T>(items: T[], what: string): T[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${what} needs at least one item`)
  return items
}

function arithmetic(op: ArithmeticOp, left: string, right: string, d: Dialect): string {
  if (!ARITHMETIC_OPS.has(op)) throw new Error(`Unknown operator: ${op}`)
  return op === '/' ? d.divide(left, right) : `(${left} ${op} ${right})`
}

export function scalarSql(e: ScalarExpr, d: Dialect): string {
  switch (e.type) {
    case 'column':
      return ident(e.name)
    case 'literal':
      return literal(e.value, d)
    case 'date_trunc':
      if (!TIME_UNITS.has(e.unit)) throw new Error(`Unknown time unit: ${e.unit}`)
      return `date_trunc('${e.unit}', ${scalarSql(e.arg, d)})`
    case 'date_part': {
      if (!DATE_PARTS.has(e.part)) throw new Error(`Unknown date part: ${e.part}`)
      const part = e.part === 'day_of_week' ? d.dayOfWeek : e.part
      return `extract(${part} from ${scalarSql(e.arg, d)})`
    }
    case 'bin': {
      if (!(e.width > 0)) throw new Error(`Bin width must be positive: ${e.width}`)
      const width = number(e.width)
      return `(floor(${scalarSql(e.arg, d)} / ${width}) * ${width})`
    }
    case 'arithmetic':
      return arithmetic(e.op, scalarSql(e.left, d), scalarSql(e.right, d), d)
    case 'coalesce':
      return `coalesce(${nonEmpty(e.args, 'coalesce')
        .map((a) => scalarSql(a, d))
        .join(', ')})`
    case 'case': {
      const cases = nonEmpty(e.cases, 'case').map((c) => `when ${predicateSql(c.when, d)} then ${scalarSql(c.then, d)}`)
      const otherwise = e.else ? ` else ${scalarSql(e.else, d)}` : ''
      return `(case ${cases.join(' ')}${otherwise} end)`
    }
    default:
      throw new Error(`Unknown expression: ${JSON.stringify(e)}`)
  }
}

export function predicateSql(p: Predicate, d: Dialect): string {
  switch (p.type) {
    case 'compare': {
      const op = COMPARE_OPS[p.op]
      if (!op) throw new Error(`Unknown comparison: ${p.op}`)
      return `(${scalarSql(p.left, d)} ${op} ${scalarSql(p.right, d)})`
    }
    case 'in':
      return `(${scalarSql(p.arg, d)} in (${nonEmpty(p.values, 'in')
        .map((v) => literal(v, d))
        .join(', ')}))`
    case 'is_null':
      return `(${scalarSql(p.arg, d)} is null)`
    case 'and':
    case 'or':
      return `(${nonEmpty(p.args, p.type)
        .map((a) => predicateSql(a, d))
        .join(` ${p.type} `)})`
    case 'not':
      return `(not ${predicateSql(p.arg, d)})`
    default:
      throw new Error(`Unknown predicate: ${JSON.stringify(p)}`)
  }
}

export function aggregateSql(e: AggregateExpr, d: Dialect): string {
  switch (e.type) {
    case 'aggregate': {
      const fn = AGGREGATES[e.fn]
      if (!fn) throw new Error(`Unknown aggregate: ${e.fn}`)
      if (!e.arg && e.fn !== 'count') throw new Error(`${e.fn} requires an argument`)
      let arg = e.arg ? scalarSql(e.arg, d) : '*'
      // Snowflake has no `filter (where ...)`: non-matching rows become null, which aggregates skip.
      if (e.where) arg = `case when ${predicateSql(e.where, d)} then ${e.arg ? arg : '1'} end`
      return `${fn}(${e.fn === 'count_distinct' ? 'distinct ' : ''}${arg})`
    }
    case 'literal':
      return number(e.value)
    case 'arithmetic':
      return arithmetic(e.op, aggregateSql(e.left, d), aggregateSql(e.right, d), d)
    default:
      throw new Error(`Unknown expression: ${JSON.stringify(e)}`)
  }
}
