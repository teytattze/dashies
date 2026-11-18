import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import type { ChartSpec, ResultColumn, Row, ValueFormat } from '@/lib/api'

/** Categorical colours, assigned to series in this fixed order (see `index.css`). */
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`)
const OTHER = 'Other'

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function formatValue(value: unknown, format?: ValueFormat): string {
  if (value === null || value === undefined) return '–'
  if (typeof value !== 'number') return typeof value === 'object' ? JSON.stringify(value) : String(value)
  const digits = format?.maximumFractionDigits
  switch (format?.style) {
    case 'currency':
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: format.currency ?? 'USD', maximumFractionDigits: digits ?? 2 }).format(value)
    case 'percent':
      return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: digits ?? 1 }).format(value)
    case 'compact':
      return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: digits ?? 1 }).format(value)
    default:
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits ?? 2 }).format(value)
  }
}

/** Axis ticks are always short: large values are abbreviated unless a format says otherwise. */
const formatTick = (value: unknown, format?: ValueFormat) =>
  formatValue(value, format?.style ? format : { ...format, style: 'compact' })

/** Formats a dimension value. Dates lose their time; whole months lose their day. */
function labeller(column: ResultColumn | undefined, rows: Row[]): (value: unknown) => string {
  if (column?.type !== 'date' && column?.type !== 'timestamp') return (value) => (value === null || value === undefined ? '(none)' : String(value))
  const values = rows.map((r) => String(r[column.name] ?? ''))
  const dateOnly = values.every((v) => v.length <= 10 || /T00:00:00(\.0+)?/.test(v))
  const monthly = dateOnly && values.every((v) => v === '' || v.slice(8, 10) === '01')
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    ...(monthly
      ? { month: 'short', year: 'numeric' }
      : dateOnly
        ? { month: 'short', day: 'numeric', year: 'numeric' }
        : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  })
  return (value) => {
    if (value === null || value === undefined) return '(none)'
    const text = String(value)
    // Timestamps without a zone are UTC.
    const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) || text.length <= 10 ? text : `${text.slice(0, 23)}Z`)
    return Number.isNaN(time) ? text : format.format(time)
  }
}

/**
 * One object per x value, with one numeric property per series. A `series`
 * column is spread into a property per distinct value; past eight, the
 * smallest fold into "Other".
 *
 * `source` gives the result row a drawn value came from, for drill-down. It
 * is undefined where a value is the sum of several rows ("Other").
 */
function pivot(rows: Row[], spec: Extract<ChartSpec, { x: string }>): { data: Row[]; keys: string[]; source(entry: unknown, key: string): Row | undefined } {
  if (!spec.series) {
    const origin = new Map<unknown, Row>()
    const data = rows.map((row) => {
      const entry = { ...row, ...Object.fromEntries(spec.y.map((y) => [y, toNumber(row[y])])) }
      origin.set(entry, row)
      return entry
    })
    return { data, keys: spec.y, source: (entry) => origin.get(entry) }
  }
  const totals = new Map<string, number>()
  const keyOf = (row: Row, y: string) => {
    const name = row[spec.series!] === null || row[spec.series!] === undefined ? '(none)' : String(row[spec.series!])
    return spec.y.length === 1 ? name : `${name} · ${y}`
  }
  for (const row of rows) for (const y of spec.y) totals.set(keyOf(row, y), (totals.get(keyOf(row, y)) ?? 0) + Math.abs(toNumber(row[y]) ?? 0))
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!)
  const kept = new Set(ranked.length > COLORS.length ? ranked.slice(0, COLORS.length - 1) : ranked)
  // Alphabetical, so a series keeps its colour when the data changes.
  const keys = [...kept].sort((a, b) => a.localeCompare(b))
  if (kept.size < ranked.length) keys.push(OTHER)

  const byX = new Map<unknown, Row>()
  const origin = new Map<unknown, Map<string, Row | undefined>>()
  for (const row of rows) {
    const entry = byX.get(row[spec.x]) ?? { [spec.x]: row[spec.x] }
    byX.set(row[spec.x], entry)
    for (const y of spec.y) {
      const value = toNumber(row[y])
      if (value === null) continue
      const key = kept.has(keyOf(row, y)) ? keyOf(row, y) : OTHER
      const sources = origin.get(entry) ?? new Map<string, Row | undefined>()
      origin.set(entry, sources)
      sources.set(key, key in entry ? undefined : row)
      entry[key] = ((entry[key] as number | undefined) ?? 0) + value
    }
  }
  return { data: [...byX.values()], keys, source: (entry, key) => (key === OTHER ? undefined : origin.get(entry)?.get(key)) }
}

const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const
/** Fills its parent, and names each series for the tooltip and legend. Colours are set on the marks. */
const container = (keys: string[]) => ({
  className: 'aspect-auto h-full w-full',
  config: Object.fromEntries(keys.map((key) => [key, { label: key }])) satisfies ChartConfig,
})
const legend = <ChartLegend content={<ChartLegendContent className="flex-wrap gap-y-1" />} />

type Select = ((row: Row) => void) | undefined
const clickable = { cursor: 'pointer' } as const

function Cartesian({ spec, rows, columns, onSelect }: { spec: Extract<ChartSpec, { x: string }>; rows: Row[]; columns: ResultColumn[]; onSelect: Select }) {
  const { data, keys, source } = pivot(rows, spec)
  const pick = (entry: unknown, key: string) => {
    const row = source(entry, key)
    if (row) onSelect?.(row)
  }
  /** The dot under the pointer on a line or area: the click target of that point. */
  const activeDot = (key: string) =>
    onSelect ? { r: 5, style: clickable, onClick: (_: unknown, dot: unknown) => pick((dot as { payload?: unknown }).payload, key) } : { r: 4 }
  const label = labeller(columns.find((c) => c.name === spec.x), rows)
  const value = (v: unknown) => formatValue(v, spec.format)
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <YAxis {...axis} width={56} tickFormatter={(v) => formatTick(v, spec.format)} />
      <ChartTooltip content={<ChartTooltipContent valueFormatter={value} labelFormatter={(_, items) => label(items[0]?.payload?.[spec.x])} />} />
      {keys.length > 1 && legend}
    </>
  )
  const xAxis = <XAxis {...axis} dataKey={spec.x} tickFormatter={label} minTickGap={24} />
  const margin = { top: 8, right: 16, bottom: 0, left: 0 }

  if (spec.type === 'scatter') {
    return (
      <ChartContainer {...container(keys)}>
        <ScatterChart margin={margin}>
          <CartesianGrid />
          <XAxis {...axis} dataKey="x" type="number" name={spec.x} tickFormatter={(v) => formatTick(v)} />
          <YAxis {...axis} dataKey="y" type="number" name={spec.y.join(', ')} width={56} tickFormatter={(v) => formatTick(v, spec.format)} />
          <ChartTooltip content={<ChartTooltipContent hideLabel valueFormatter={value} />} />
          {keys.length > 1 && legend}
          {keys.map((key, i) => (
            <Scatter
              key={key}
              name={key}
              fill={COLORS[i]}
              stroke="var(--card)"
              strokeWidth={2}
              data={data.flatMap((d) => (toNumber(d[spec.x]) === null || d[key] == null ? [] : [{ x: toNumber(d[spec.x]), y: d[key], entry: d }]))}
              style={onSelect ? clickable : undefined}
              onClick={(point: { entry?: unknown; payload?: { entry?: unknown } }) => pick(point.entry ?? point.payload?.entry, key)}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
    )
  }
  if (spec.type === 'line') {
    return (
      <ChartContainer {...container(keys)}>
        <LineChart data={data} margin={margin}>
          {common}
          {xAxis}
          {keys.map((key, i) => (
            <Line key={key} dataKey={key} type="linear" stroke={COLORS[i]} strokeWidth={2} dot={data.length <= 31 ? { r: 3 } : false} activeDot={activeDot(key)} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ChartContainer>
    )
  }
  if (spec.type === 'area') {
    const stacked = spec.stacked ?? keys.length > 1
    return (
      <ChartContainer {...container(keys)}>
        <AreaChart data={data} margin={margin}>
          {common}
          {xAxis}
          {keys.map((key, i) => (
            <Area key={key} dataKey={key} type="linear" stackId={stacked ? 'stack' : undefined} stroke={COLORS[i]} strokeWidth={2} fill={COLORS[i]} fillOpacity={stacked ? 0.7 : 0.2} activeDot={activeDot(key)} connectNulls isAnimationActive={false} />
          ))}
        </AreaChart>
      </ChartContainer>
    )
  }
  return (
    <ChartContainer {...container(keys)}>
      <BarChart data={data} margin={margin} barCategoryGap="20%">
        {common}
        {xAxis}
        {keys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            stackId={spec.stacked ? 'stack' : undefined}
            fill={COLORS[i]}
            // A surface-coloured outline separates neighbouring and stacked bars.
            stroke="var(--card)"
            strokeWidth={1}
            radius={spec.stacked ? 0 : [4, 4, 0, 0]}
            maxBarSize={56}
            isAnimationActive={false}
            style={onSelect ? clickable : undefined}
            onClick={(bar: { payload?: unknown }) => pick(bar.payload, key)}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

function PieView({ spec, rows, onSelect }: { spec: Extract<ChartSpec, { type: 'pie' }>; rows: Row[]; onSelect: Select }) {
  const slices: { name: string; value: number; row?: Row }[] = rows
    .map((row) => ({ row, name: row[spec.category] == null ? '(none)' : String(row[spec.category]), value: toNumber(row[spec.value]) ?? 0 }))
    .sort((a, b) => b.value - a.value)
  const kept = slices.length > COLORS.length ? slices.slice(0, COLORS.length - 1) : slices
  const rest = slices.slice(kept.length).reduce((sum, s) => sum + s.value, 0)
  const data = [...kept, ...(slices.length > kept.length ? [{ name: OTHER, value: rest }] : [])].map((s, i) => ({ ...s, fill: COLORS[i] }))
  return (
    <ChartContainer {...container(data.map((s) => s.name))}>
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent hideLabel valueFormatter={(v) => formatValue(v, spec.format)} />} />
        {legend}
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" stroke="var(--card)" strokeWidth={2} isAnimationActive={false}
          style={onSelect ? clickable : undefined}
          onClick={(slice: { row?: Row; payload?: { row?: Row } }) => {
            const row = slice.row ?? slice.payload?.row
            if (row) onSelect?.(row)
          }}
        />
      </PieChart>
    </ChartContainer>
  )
}

function Stat({ spec, rows, onSelect }: { spec: Extract<ChartSpec, { type: 'stat' }>; rows: Row[]; onSelect: Select }) {
  const value = toNumber(rows[0]?.[spec.value])
  const previous = spec.comparison ? toNumber(rows[0]?.[spec.comparison]) : null
  const change = value !== null && previous ? (value - previous) / Math.abs(previous) : null
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <div
        className={`text-6xl font-semibold tracking-tight tabular-nums ${onSelect ? 'cursor-pointer hover:underline' : ''}`}
        role={onSelect ? 'button' : undefined}
        onClick={() => rows[0] && onSelect?.(rows[0])}
      >
        {formatValue(value ?? rows[0]?.[spec.value], spec.format)}
      </div>
      <div className="text-muted-foreground text-sm">{spec.value}</div>
      {change !== null && (
        <div className="text-sm tabular-nums">
          {change >= 0 ? '▲' : '▼'} {formatValue(Math.abs(change), { style: 'percent' })}{' '}
          <span className="text-muted-foreground">vs {formatValue(previous, spec.format)}</span>
        </div>
      )}
    </div>
  )
}

/** Dates and times arrive as ISO text: a table shows them to the day or the minute. */
function formatCell(value: unknown, column: { format?: ValueFormat; type?: ResultColumn['type'] }): string {
  if (typeof value === 'string' && column.type === 'date') return value.slice(0, 10)
  if (typeof value === 'string' && column.type === 'timestamp') return value.slice(0, 16).replace('T', ' ')
  return formatValue(value, column.format)
}

/** The rows as a table: the `table` chart type, and the data view of every other. */
export function DataTable({ rows, columns, onSelect }: { rows: Row[]; columns: { field: string; label?: string; format?: ValueFormat; type?: ResultColumn['type'] }[]; onSelect?: Select }) {
  const shown = rows.slice(0, 500)
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-card sticky top-0">
          <tr>
            {columns.map((c) => (
              <th key={c.field} className="text-muted-foreground border-b px-3 py-2 text-left font-medium whitespace-nowrap">
                {c.label ?? c.field}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className={`hover:bg-muted/50 ${onSelect ? 'cursor-pointer' : ''}`} onClick={() => onSelect?.(row)}>
              {columns.map((c) => (
                <td key={c.field} className={`border-b px-3 py-1.5 whitespace-nowrap ${typeof row[c.field] === 'number' ? 'text-right tabular-nums' : ''}`}>
                  {formatCell(row[c.field], c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p className="text-muted-foreground p-3 text-xs">Showing the first {shown.length} of {rows.length} rows.</p>}
    </div>
  )
}

/** A data point's dimension values as a short label, e.g. "Mar 2026 · Design". */
export function PointLabel({ point, columns, rows }: { point: Row; columns: ResultColumn[]; rows: Row[] }) {
  return Object.entries(point)
    .map(([name, value]) => labeller(columns.find((c) => c.name === name), rows)(value))
    .join(' · ')
}

/**
 * Draws a chart run's rows as the chart's spec says. With `onSelect`, data
 * points can be clicked; it is given the result row behind the point.
 */
export function ChartView({ spec, rows, columns, onSelect }: { spec: ChartSpec; rows: Row[]; columns: ResultColumn[]; onSelect?: Select }) {
  if (rows.length === 0) return <p className="text-muted-foreground flex h-full items-center justify-center text-sm">The query returned no rows.</p>
  if (spec.type === 'table') return <DataTable rows={rows} columns={spec.columns ?? columns.map((c) => ({ field: c.name }))} onSelect={onSelect} />
  if (spec.type === 'stat') return <Stat spec={spec} rows={rows} onSelect={onSelect} />
  return spec.type === 'pie' ? <PieView spec={spec} rows={rows} onSelect={onSelect} /> : <Cartesian spec={spec} rows={rows} columns={columns} onSelect={onSelect} />
}
