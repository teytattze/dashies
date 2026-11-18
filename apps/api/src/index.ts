import { anthropic } from '@ai-sdk/anthropic'
import type { GenerateDeps } from './ai/generate.ts'
import { db } from './db/client.ts'
import { createApp } from './http.ts'
import { snowflake } from './query/dialect.ts'
import { explorer } from './snowflake/catalog.ts'
import { connect } from './snowflake/connect.ts'

const deps: GenerateDeps = {
  db,
  connect,
  dialect: snowflake,
  // Reads ANTHROPIC_API_KEY.
  model: anthropic(process.env.AI_MODEL ?? 'claude-opus-5-5'),
  explore: async (source) => explorer(await connect(source)),
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: createApp(deps).fetch,
  // A reply from the AI streams for minutes; Bun's default closes idle connections after 10 seconds.
  idleTimeout: 255,
})

console.log(`api listening on ${server.url}`)
