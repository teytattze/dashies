/**
 * Registers the Snowflake connection from SNOWFLAKE_* (see `.env.example`) as
 * a data source in the app database, so charts can be built on it:
 *
 *   bun run seed:datasource
 *
 * Safe to run again: it updates the same workspace and data source, e.g.
 * after the access token has been rotated.
 */
import { encryptSecret } from '../crypto.ts'
import { db } from '../db/client.ts'
import * as s from '../db/schema.ts'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const config = {
  account: env('SNOWFLAKE_ACCOUNT'),
  warehouse: env('SNOWFLAKE_WAREHOUSE'),
  database: env('SNOWFLAKE_DATABASE'),
  schema: env('SNOWFLAKE_SCHEMA'),
  role: process.env.SNOWFLAKE_ROLE || undefined,
}
const encryptedCredentials = await encryptSecret(env('SNOWFLAKE_TOKEN'))

const [workspace] = await db
  .insert(s.workspaces)
  .values({ name: 'Test', slug: 'test' })
  .onConflictDoUpdate({ target: s.workspaces.slug, set: { name: 'Test' } })
  .returning()
const [source] = await db
  .insert(s.dataSources)
  .values({ workspaceId: workspace!.id, name: 'Snowflake test data', config, encryptedCredentials })
  .onConflictDoUpdate({ target: [s.dataSources.workspaceId, s.dataSources.name], set: { config, encryptedCredentials } })
  .returning()

console.log(`Data source "${source!.name}" (${config.database}.${config.schema}): ${source!.id}`)
process.exit(0)
