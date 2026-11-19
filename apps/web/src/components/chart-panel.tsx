import { ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ChartView, DataTable, PointLabel } from '@/components/chart-view'
import { RunSql } from '@/components/run-sql'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  type Chart,
  type ChartFilter,
  type DrillRequest,
  type FilterChoice,
  type FilterSelection,
  finished,
  getChart,
  getFilterOptions,
  type Row,
  type Run,
  startDrillRun,
  startRun,
} from '@/lib/api'

/**
 * A filter as the viewer sees it: its options are written into the chart, or read from the warehouse.
 * `error` is why a lookup filter's options could not be read; it then has none to pick from.
 */
type Control = { name: string; multi: boolean; options: FilterChoice[]; error?: string }

/** The options of a chart's lookup filters, or why they could not be read. */
type Lookups = { options: Record<string, FilterChoice[]> } | { error: string }

const readLookups = (chartId: string): Promise<Lookups> =>
  getFilterOptions(chartId).then(
    (options) => ({ options }),
    (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  )

const controlsOf = (filters: ChartFilter[], lookups: Lookups): Control[] =>
  filters.map((filter) => {
    const control = { name: filter.name, multi: filter.multi ?? false }
    if (filter.kind !== 'lookup') return { ...control, options: filter.options }
    if ('error' in lookups) return { ...control, options: [], error: lookups.error }
    return { ...control, options: lookups.options[filter.name] ?? [] }
  })


/**
 * The picked options the chart's filters still have (the AI may have changed
 * them since). A filter that was not picked from is left out, so its default applies.
 */
function fitting(controls: Control[], picked: FilterSelection): FilterSelection {
  return Object.fromEntries(
    controls.flatMap((control) => {
      // Nothing can be picked from options that could not be read. Saying so keeps the run from needing them for a default.
      if (control.error) return [[control.name, []]]
      const keys = picked[control.name]
      if (!keys) return []
      const kept = control.options.map((o) => o.key).filter((key) => keys.includes(key))
      return [[control.name, control.multi ? kept : kept.slice(0, 1)]]
    }),
  )
}

/**
 * The chart being built: its latest definition, run against the warehouse.
 * It is read and run again whenever `version` changes (the AI saved it).
 */
export function ChartPanel({ chartId, version, building }: { chartId: string | null; version: number; building: boolean }) {
  // The chart and the run of that same definition, replaced together so rows are never drawn with another spec.
  const [shown, setShown] = useState<{ chart: Chart; controls: Control[]; run: Run | null } | null>(null)
  // The request that last finished, and its error if it failed. Loading = the current request has not finished.
  const [settled, setSettled] = useState<{ request: string; error: string | null } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [view, setView] = useState<'chart' | 'data'>('chart')
  // The clicked data point (its dimension values), and the chart run it was clicked on.
  const [drilled, setDrilled] = useState<{ runId: string; point: Row } | null>(null)
  // The filter options the viewer picked, and for which chart. Until they pick, the run applies each filter's default.
  const [asked, setAsked] = useState<{ chartId: string; filters: FilterSelection } | null>(null)
  const picked = asked?.chartId === chartId ? asked.filters : undefined
  const request = `${chartId}:${version}:${refresh}:${JSON.stringify(picked)}`
  const loading = chartId !== null && settled?.request !== request
  const error = settled?.request === request ? settled.error : null
  // The lookup options are read once per definition and refresh, not again for every pick.
  const lookupsKey = `${chartId}:${version}:${refresh}`
  const lookupsRead = useRef<{ key: string; lookups: Promise<Lookups> } | null>(null)

  useEffect(() => {
    if (!chartId) return
    let cancelled = false
    const settle = (error: string | null) => {
      if (!cancelled) setSettled({ request, error })
    }
    void (async () => {
      const chart = await getChart(chartId)
      if (cancelled) return
      if (!chart.query) return setShown({ chart, controls: [], run: null })
      const { filters } = chart.query
      let lookups: Lookups = { options: {} }
      // Only lookup filters have options to fetch.
      if (filters.some((f) => f.kind === 'lookup')) {
        if (lookupsRead.current?.key !== lookupsKey) lookupsRead.current = { key: lookupsKey, lookups: readLookups(chartId) }
        lookups = await lookupsRead.current.lookups
      }
      const controls = controlsOf(filters, lookups)
      if (cancelled) return
      const sent = picked || controls.some((c) => c.error) ? fitting(controls, picked ?? {}) : undefined
      const run = await finished(await startRun(chartId, sent), () => cancelled)
      if (!cancelled) setShown({ chart, controls, run })
    })().then(
      () => settle(null),
      (e: unknown) => settle(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      cancelled = true
    }
  }, [chartId, request, picked, lookupsKey])

  const chart = shown?.chart
  const run = shown?.run
  const rows = run?.status === 'succeeded' ? run.rows : null
  const columns = run?.columns ?? chart?.query?.resultColumns ?? []
  const filters = chart?.spec && chart.id === chartId ? (shown?.controls ?? []) : []
  // What the controls show: the viewer's picks at once, before the run they started has finished; else what the run applied.
  const selection = fitting(filters, picked ?? run?.filters ?? {})
  const pick = (name: string, keys: string[]) => chartId && setAsked({ chartId, filters: { ...selection, [name]: keys } })
  // A point of an earlier run is gone once the chart has run again, as it does when a filter changes.
  const point = run && drilled?.runId === run.id ? drilled.point : null
  const select =
    run?.drillToken && chart?.query
      ? (row: Row) => setDrilled({ runId: run.id, point: Object.fromEntries(chart.query!.dimensions.map((d) => [d.name, row[d.name] ?? null])) })
      : undefined

  let body
  if (error) body = <Notice tone="error">{error}</Notice>
  else if (run?.status === 'failed') body = <Notice tone="error">The query failed: {run.error}</Notice>
  else if (chart?.spec && rows) {
    body =
      view === 'data' && chart.spec.type !== 'table' ? (
        <DataTable rows={rows} columns={columns.map((c) => ({ field: c.name, type: c.type }))} onSelect={select} />
      ) : (
        <ChartView spec={chart.spec} rows={rows} columns={columns} onSelect={select} />
      )
  } else if (loading || building) body = <Notice>{building ? 'The assistant is building the chart…' : 'Running the query…'}</Notice>
  else body = <Notice>{chartId ? 'This chart has not been built yet.' : 'Describe a chart in the chat and it appears here.'}</Notice>

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-6">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-tight">{chart?.spec ? chart.title : 'New chart'}</h2>
          {chart?.description && <p className="text-muted-foreground mt-0.5 text-sm">{chart.description}</p>}
        </div>
        {loading && <LoaderCircle className="text-muted-foreground mt-1.5 size-4 animate-spin" aria-label="Running" />}
        {chart?.spec && chart.spec.type !== 'table' && (
          <div className="bg-muted flex rounded-md p-0.5 text-sm">
            {(['chart', 'data'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded px-2.5 py-1 capitalize ${view === v ? 'bg-background shadow-xs' : 'text-muted-foreground'}`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        {chart?.spec && run && <RunSql run={run} />}
        {chart?.spec && (
          <Button variant="outline" size="icon-sm" onClick={() => setRefresh((n) => n + 1)} disabled={loading} aria-label="Run again">
            <RefreshCw />
          </Button>
        )}
      </header>
      {filters.length > 0 && <FilterBar filters={filters} selection={selection} onPick={pick} />}
      <div className={`bg-card min-h-0 flex-1 rounded-xl border p-4 transition-opacity ${loading && rows ? 'opacity-60' : ''}`}>{body}</div>
      {rows && run?.rowCount != null && run.rowCount > rows.length && (
        <p className="text-muted-foreground text-xs">
          Showing {rows.length} of {run.rowCount} rows.
        </p>
      )}
      {select && !point && rows && rows.length > 0 && <p className="text-muted-foreground text-xs">Click a data point to see the rows behind it.</p>}
      {chartId && run?.drillToken && point && rows && (
        <DrillList
          key={`${run.id}:${JSON.stringify(point)}`}
          chartId={chartId}
          token={run.drillToken}
          point={point}
          title={<PointLabel point={point} columns={columns} rows={rows} />}
          onClose={() => setDrilled(null)}
        />
      )}
    </section>
  )
}

/** One control per filter. "All" is a filter with nothing picked. */
function FilterBar(props: { filters: Control[]; selection: FilterSelection; onPick(name: string, keys: string[]): void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {props.filters.map((filter) => {
        const keys = props.selection[filter.name] ?? []
        const onPick = (next: string[]) => props.onPick(filter.name, next)
        let control
        if (filter.error) {
          control = (
            <span className="text-destructive text-xs" title={filter.error}>
              Options unavailable
            </span>
          )
        } else if (filter.options.length === 0) control = <span className="text-muted-foreground text-xs">No values</span>
        else control = <FilterMenu filter={filter} keys={keys} onPick={onPick} />
        return (
          <div key={filter.name} role="group" aria-label={filter.name} className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground mr-0.5 text-xs font-medium">{filter.name}</span>
            {control}
          </div>
        )
      })}
    </div>
  )
}

/** A filter's options in a dropdown menu, ticked when picked. */
function FilterMenu({ filter, keys, onPick }: { filter: Control; keys: string[]; onPick(keys: string[]): void }) {
  const picked = filter.options.filter((o) => keys.includes(o.key))
  const summary = picked.length === 0 ? 'All' : picked.length <= 2 ? picked.map((o) => o.label).join(', ') : `${picked.length} selected`
  // A menu closes when an item is chosen; one that takes several picks stays open for the next.
  const chosen = (e: Event) => filter.multi && e.preventDefault()
  const toggled = (key: string, checked: boolean) => {
    if (!checked) return keys.filter((k) => k !== key)
    return filter.multi ? [...keys, key] : [key]
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant={picked.length ? 'default' : 'outline'} className="max-w-64" aria-label={`${filter.name}: ${summary}`}>
          <span className="truncate">{summary}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 max-w-72">
        <DropdownMenuCheckboxItem checked={keys.length === 0} onCheckedChange={() => onPick([])} onSelect={chosen}>
          All
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {filter.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.key}
            checked={keys.includes(option.key)}
            onCheckedChange={(checked) => onPick(toggled(option.key, checked))}
            onSelect={chosen}
          >
            <span className="truncate">{option.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The rows behind one clicked data point, a page at a time. */
function DrillList(props: { chartId: string; token: string; point: Row; title: React.ReactNode; onClose(): void }) {
  const { chartId, token, point } = props
  const [target, setTarget] = useState<DrillRequest>({ token, row: point })
  // The last page that loaded, kept on screen while the next one loads.
  const [page, setPage] = useState<Run | null>(null)
  const [settled, setSettled] = useState<{ target: DrillRequest; error: string | null } | null>(null)
  const loading = settled?.target !== target
  const error = loading ? null : settled.error

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const run = await finished(await startDrillRun(chartId, target), () => cancelled)
      if (cancelled) return
      if (run.status === 'failed') throw new Error(`The query failed: ${run.error}`)
      setPage(run)
    })().then(
      () => cancelled || setSettled({ target, error: null }),
      (e: unknown) => cancelled || setSettled({ target, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [chartId, target])

  const drill = page?.drill
  const first = drill ? drill.page * drill.pageSize : 0
  const go = (to: number) => page && setTarget({ after: page.id, page: to })

  return (
    <div className="bg-card flex h-[42%] min-h-48 shrink-0 flex-col rounded-xl border">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title || 'All rows'}</h3>
        {loading && <LoaderCircle className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />}
        {drill && page?.rows && page.rows.length > 0 && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {first + 1}–{first + page.rows.length}
            {drill.totalItems !== null && ` of ${drill.totalItems}${drill.truncated ? '+' : ''}`}
          </span>
        )}
        {page && <RunSql run={page} variant="ghost" />}
        <Button variant="ghost" size="icon-sm" disabled={loading || !drill || drill.page === 0} onClick={() => drill && go(drill.page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={loading || !drill?.hasNextPage} onClick={() => drill && go(drill.page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label="Close">
          <X />
        </Button>
      </header>
      <div className={`min-h-0 flex-1 transition-opacity ${loading && page ? 'opacity-60' : ''}`}>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : page?.rows?.length ? (
          <DataTable rows={page.rows} columns={(page.columns ?? []).map((c) => ({ field: c.name, type: c.type }))} />
        ) : (
          <Notice>{loading ? 'Loading rows…' : 'No rows.'}</Notice>
        )}
      </div>
    </div>
  )
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <p className={`flex h-full items-center justify-center px-6 text-center text-sm ${tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
      {children}
    </p>
  )
}
