import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ChartPanel } from '@/components/chart-panel'
import { Chat } from '@/components/chat'
import { Button } from '@/components/ui/button'
import { type ChartSummary, createThread, type DataSource, getMessages, listCharts, listDataSources } from '@/lib/api'

/** One chat about one chart. A new chart has no IDs until its first message is sent. */
type Session = { key: string; chartId: string | null; threadId: string | null; messages: UIMessage[] }

const newSession = (): Session => ({ key: crypto.randomUUID(), chartId: null, threadId: null, messages: [] })

/** Keeps the open chart in the address bar, so a reload returns to it. */
function showInUrl(chartId: string | null) {
  const url = new URL(location.href)
  if (chartId) url.searchParams.set('chart', chartId)
  else url.searchParams.delete('chart')
  history.replaceState(null, '', url)
}

function Workspace(props: { session: Session; dataSource: DataSource | undefined; onCreated(chartId: string): void; onReplied(): void }) {
  const { session, dataSource, onCreated, onReplied } = props
  const [chartId, setChartId] = useState(session.chartId)
  const [threadId, setThreadId] = useState(session.threadId)

  const [transport] = useState(
    () =>
      new DefaultChatTransport<UIMessage>({
        // The server keeps the conversation: it is sent only the new message.
        prepareSendMessagesRequest: ({ messages, body }) => {
          const text = (messages.at(-1)?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          // Passed with each message, below.
          const { threadId, dataSourceId } = (body ?? {}) as { threadId?: string | null; dataSourceId?: string }
          return threadId
            ? { api: `/api/threads/${threadId}/messages`, body: { text } }
            : { api: '/api/charts', body: { dataSourceId, prompt: text } }
        },
        // The first message creates the chart and its thread, named in the response headers.
        fetch: async (input, init) => {
          const response = await fetch(input, init)
          const created = response.headers.get('x-chart-id')
          const thread = response.headers.get('x-thread-id')
          if (response.ok && created && thread) {
            setThreadId(thread)
            setChartId(created)
            onCreated(created)
          }
          return response
        },
      }),
  )
  const { messages, status, error, sendMessage, stop } = useChat({ id: session.key, messages: session.messages, transport, onFinish: onReplied })

  // Each successful save changes the chart, so the panel runs it again.
  const saves = messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'tool-save_chart' && p.state === 'output-available' && !(p.output && typeof p.output === 'object' && 'error' in p.output)).length

  return (
    <>
      <Chat
        messages={messages}
        status={status}
        error={error}
        blocked={dataSource ? undefined : 'No data source yet. Run `bun run seed:datasource` in apps/api, then reload.'}
        onSend={(text) => void sendMessage({ text }, { body: { threadId, dataSourceId: dataSource?.id } })}
        onStop={() => void stop()}
      />
      <ChartPanel chartId={chartId} version={saves} building={status === 'submitted' || status === 'streaming'} />
    </>
  )
}

export default function App() {
  const [sources, setSources] = useState<DataSource[] | null>(null)
  const [sourceId, setSourceId] = useState<string>()
  const [charts, setCharts] = useState<ChartSummary[]>([])
  const [session, setSession] = useState<Session>(newSession)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))
  const reload = useCallback(() => listCharts().then(setCharts).catch(fail), [])

  const open = useCallback(async (chart: Pick<ChartSummary, 'id' | 'threadId'>) => {
    try {
      const threadId = chart.threadId ?? (await createThread(chart.id))
      setSession({ key: crypto.randomUUID(), chartId: chart.id, threadId, messages: await getMessages(threadId) })
      setActiveId(chart.id)
      showInUrl(chart.id)
      setError(null)
    } catch (e) {
      fail(e)
    }
  }, [])

  useEffect(() => {
    listDataSources()
      .then((list) => {
        setSources(list)
        setSourceId(list[0]?.id)
      })
      .catch(fail)
    listCharts()
      .then((list) => {
        setCharts(list)
        const wanted = new URLSearchParams(location.search).get('chart')
        const chart = list.find((c) => c.id === wanted)
        if (chart) void open(chart)
      })
      .catch(fail)
  }, [open])

  const startNew = () => {
    setSession(newSession())
    setActiveId(null)
    showInUrl(null)
  }
  const active = charts.find((c) => c.id === activeId)
  // An existing chart stays on the source it was built on.
  const dataSource = sources?.find((s) => s.id === (active?.dataSourceId ?? sourceId))

  return (
    <div className="flex h-svh">
      <aside className="bg-sidebar flex w-60 shrink-0 flex-col gap-3 border-r p-3">
        <h1 className="px-2 pt-1 text-lg font-semibold tracking-tight">Dashies</h1>
        <Button variant="outline" size="sm" onClick={startNew}>
          <Plus /> New chart
        </Button>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label="Charts">
          {charts.map((chart) => (
            <button
              key={chart.id}
              type="button"
              onClick={() => void open(chart)}
              aria-current={chart.id === activeId ? 'page' : undefined}
              className={`hover:bg-sidebar-accent truncate rounded-md px-2 py-1.5 text-left text-sm ${chart.id === activeId ? 'bg-sidebar-accent font-medium' : ''} ${chart.built ? '' : 'text-muted-foreground'}`}
            >
              {chart.title}
            </button>
          ))}
        </nav>
        <label className="text-muted-foreground flex flex-col gap-1 px-1 text-xs">
          Data source
          {sources && sources.length > 1 && !active ? (
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="text-foreground rounded-md border bg-transparent px-1.5 py-1 text-sm">
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-foreground truncate text-sm">{dataSource?.name ?? (sources ? 'None' : '…')}</span>
          )}
          {dataSource && (
            <span className="truncate">
              {dataSource.database}
              {dataSource.schema ? `.${dataSource.schema}` : ''}
            </span>
          )}
        </label>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {error && <p className="bg-destructive/10 text-destructive border-b px-4 py-2 text-sm">{error}</p>}
        <div className="flex min-h-0 flex-1">
          {sources && (
            <Workspace
              key={session.key}
              session={session}
              dataSource={dataSource}
              onCreated={(chartId) => {
                setActiveId(chartId)
                showInUrl(chartId)
                void reload()
              }}
              onReplied={() => void reload()}
            />
          )}
        </div>
      </main>
    </div>
  )
}
