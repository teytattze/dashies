import { Code } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import type { Run } from '@/lib/api'

function Statement({ sql, title }: { sql: string; title: string }) {
  const lines = useHighlightedCode(sql, 'sql')
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={sql} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** A button that opens the SQL a run sent to the warehouse: its final statement, and the ones before it. */
export function RunSql({ run, variant = 'outline' }: { run: Run; variant?: 'outline' | 'ghost' }) {
  const count = run.statements.length
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={variant} size="icon-sm" aria-label="Show SQL">
          <Code />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>SQL</DialogTitle>
          <DialogDescription>
            {count > 1
              ? `This run sent ${count} statements to Snowflake. The final one reads the stored result of the one before it.`
              : 'The statement this run sent to Snowflake.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {run.statements.map((sql, i) => (
            <Statement key={i} sql={sql} title={count === 1 ? 'Statement' : `Statement ${i + 1} of ${count}${i === count - 1 ? ' · final' : ''}`} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
