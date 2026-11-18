/**
 * Fills a Snowflake schema with the sample `USERS` and `TASKS` tables, for
 * testing charts against real data:
 *
 *   bun run seed:snowflake [--users 200] [--tasks 5000] [--seed 1]
 *
 * Reads the connection from SNOWFLAKE_* (see `.env.example`). Creates the
 * schema if needed and REPLACES both tables in it.
 */
import { parseArgs } from 'node:util'
import { SnowflakeClient } from '../snowflake/client.ts'
import { load, seededRandom } from './domain.ts'
import { generateTasks, taskDomain } from './domains/task.ts'
import { generateUsers, userDomain } from './domains/user.ts'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function count(value: string, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
  return n
}

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '200' },
    tasks: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '1' },
  },
})

const schema = env('SNOWFLAKE_SCHEMA')
// Spliced into SQL below.
if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error(`Invalid SNOWFLAKE_SCHEMA: ${schema}`)
const client = new SnowflakeClient({
  // No default schema: it may not exist yet, so every statement names it.
  config: {
    account: env('SNOWFLAKE_ACCOUNT'),
    warehouse: env('SNOWFLAKE_WAREHOUSE'),
    database: env('SNOWFLAKE_DATABASE'),
    role: process.env.SNOWFLAKE_ROLE || undefined,
  },
  token: env('SNOWFLAKE_TOKEN'),
})

const random = seededRandom(Number(values.seed))
const now = new Date()
const users = generateUsers({ count: count(values.users, 'users'), now, random })
const tasks = generateTasks({ count: count(values.tasks, 'tasks'), now, random, users })

const target = `${client.config.database}.${schema}`
console.log(`Seeding ${target} on ${client.config.account}`)
await client.execute(`create schema if not exists ${schema}`)
await load(client, schema, userDomain, users)
console.log(`  ${userDomain.table}: ${users.length} rows`)
await load(client, schema, taskDomain, tasks)
console.log(`  ${taskDomain.table}: ${tasks.length} rows`)
