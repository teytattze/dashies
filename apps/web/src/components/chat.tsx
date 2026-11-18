import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { ArrowUp, Check, LoaderCircle, Square, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/api'

const SUGGESTIONS = ['Tasks completed per week, by team', 'Open tasks by priority', 'New user sign-ups per month']

/** What each of the AI's tools is doing, in the user's words. */
const TOOL_LABELS: Record<string, string> = {
  list_tables: 'Looking at the tables',
  describe_tables: 'Reading columns',
  sample_rows: 'Sampling data',
  get_chart: 'Reading the chart',
  save_chart: 'Saving the chart',
}

type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>

/** A tool reports a mistake the model can fix as `{ error }`; the model then tries again. */
const rejected = (part: ToolPart) =>
  part.state === 'output-available' && typeof part.output === 'object' && part.output !== null && 'error' in part.output

function ToolStep({ part }: { part: ToolPart }) {
  const name = getToolName(part)
  const failed = part.state === 'output-error'
  const done = part.state === 'output-available'
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      {failed || rejected(part) ? (
        <TriangleAlert className="size-3.5" />
      ) : done ? (
        <Check className="size-3.5" />
      ) : (
        <LoaderCircle className="size-3.5 animate-spin" />
      )}
      <span>
        {TOOL_LABELS[name] ?? name}
        {failed ? ': failed' : rejected(part) ? ': needs a fix, retrying' : ''}
      </span>
    </div>
  )
}

function Message({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
    return <div className="bg-secondary ml-8 self-end rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap">{text}</div>
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return part.text.trim() ? (
            <div key={i} className="flex flex-col gap-2 text-sm leading-relaxed [&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
              <Markdown>{part.text}</Markdown>
            </div>
          ) : null
        }
        return isToolUIPart(part) ? <ToolStep key={part.toolCallId} part={part} /> : null
      })}
    </div>
  )
}

export function Chat(props: {
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  error: Error | undefined
  /** Why nothing can be sent, e.g. no data source is set up. */
  blocked?: string
  onSend(text: string): void
  onStop(): void
}) {
  const { messages, status, error, blocked } = props
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages, status])

  const send = (text: string) => {
    if (busy || blocked || !text.trim()) return
    props.onSend(text.trim())
    setDraft('')
  }

  return (
    <section className="flex min-h-0 w-[26rem] shrink-0 flex-col border-r">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="my-auto flex flex-col gap-3">
            <h2 className="font-semibold tracking-tight">What do you want to see?</h2>
            <p className="text-muted-foreground text-sm">Describe a chart. The assistant finds the data in Snowflake and builds it.</p>
            <div className="flex flex-col items-start gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" disabled={!!blocked} onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {status === 'submitted' && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <LoaderCircle className="size-3.5 animate-spin" /> Thinking…
          </div>
        )}
        {error && <p className="text-destructive text-sm">{errorMessage(error.message) || 'Something went wrong. Try again.'}</p>}
        <div ref={end} />
      </div>

      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        {blocked && <p className="text-muted-foreground mb-2 text-xs">{blocked}</p>}
        <div className="focus-within:ring-ring/50 flex items-end gap-2 rounded-xl border p-2 focus-within:ring-[3px]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send(draft)
              }
            }}
            rows={2}
            maxLength={10_000}
            placeholder={messages.length === 0 ? 'Describe a chart…' : 'Ask for a change…'}
            aria-label="Message"
            className="placeholder:text-muted-foreground max-h-40 flex-1 resize-none bg-transparent px-1 text-sm outline-none"
          />
          {busy ? (
            <Button type="button" size="icon-sm" variant="secondary" onClick={props.onStop} aria-label="Stop">
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" disabled={!draft.trim() || !!blocked} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
