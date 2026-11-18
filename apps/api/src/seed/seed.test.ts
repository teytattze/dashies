import { expect, test } from 'bun:test'
import type { Executor } from '../snowflake/catalog.ts'
import { createTableSql, load, seededRandom } from './domain.ts'
import { generateTasks, taskDomain } from './domains/task.ts'
import { generateUsers, userDomain } from './domains/user.ts'

const now = new Date('2026-11-18T12:00:00Z')

function generate(seed = 1) {
  const random = seededRandom(seed)
  const users = generateUsers({ count: 50, now, random })
  const tasks = generateTasks({ count: 500, now, random, users })
  return { users, tasks }
}

test('the same seed gives the same data', () => {
  expect(generate(7)).toEqual(generate(7))
  expect(generate(7)).not.toEqual(generate(8))
})

test('users are unique, ordered by sign-up and fill exactly the table’s columns', () => {
  const { users } = generate()
  expect(users.map((u) => u.ID)).toEqual(users.map((_, i) => i + 1))
  expect(new Set(users.map((u) => u.EMAIL)).size).toBe(users.length)
  expect(users.map((u) => u.CREATED_AT)).toEqual(users.map((u) => u.CREATED_AT).sort())
  for (const user of users) {
    expect(Object.keys(user)).toEqual(userDomain.columns.map((c) => c.name))
    expect(Date.parse(`${user.CREATED_AT}Z`)).toBeLessThanOrEqual(now.getTime())
    if (user.LAST_SEEN_AT) expect(user.LAST_SEEN_AT >= user.CREATED_AT).toBe(true)
  }
})

test('tasks reference users who existed, and only done tasks are completed', () => {
  const { users, tasks } = generate()
  const byId = new Map(users.map((u) => [u.ID, u]))
  const iso = now.toISOString().slice(0, 23)
  for (const task of tasks) {
    expect(Object.keys(task)).toEqual(taskDomain.columns.map((c) => c.name))
    expect(byId.get(task.CREATED_BY_ID as number)!.CREATED_AT <= task.CREATED_AT).toBe(true)
    if (task.ASSIGNEE_ID !== null) expect(byId.get(task.ASSIGNEE_ID as number)!.CREATED_AT <= task.CREATED_AT).toBe(true)
    expect(task.COMPLETED_AT !== null).toBe(task.STATUS === 'done')
    if (task.COMPLETED_AT) {
      expect(task.COMPLETED_AT > task.CREATED_AT).toBe(true)
      expect(task.COMPLETED_AT <= iso).toBe(true)
    }
  }
  expect(new Set(tasks.map((t) => t.STATUS))).toEqual(new Set(['todo', 'in_progress', 'in_review', 'done', 'cancelled']))
})

test('load replaces the table and inserts rows in batches of JSON', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const client: Executor = {
    execute: async (sql, params = []) => {
      calls.push({ sql, params })
      return { queryId: 'q', columns: [], rows: [], totalRows: 0 }
    },
  }
  const { users } = generate()
  await load(client, 'TEST', userDomain, users, 20)

  expect(calls.map((c) => c.sql.split('\n')[0])).toEqual([
    'create or replace table TEST.USERS (',
    ...Array(3).fill('insert into TEST.USERS (ID, EMAIL, NAME, ROLE, TEAM, COUNTRY, IS_ACTIVE, CREATED_AT, LAST_SEEN_AT)'),
  ])
  expect(calls[1]!.sql).toContain('value:"CREATED_AT"::timestamp_ntz')
  expect(calls[1]!.sql).toEndWith('from table(flatten(input => parse_json(?)))')

  const inserted = calls.slice(1).flatMap((c) => JSON.parse(c.params[0] as string) as Record<string, unknown>[])
  expect(inserted).toHaveLength(50)
  // Nulls are left out so they arrive as SQL NULL.
  const neverSeen = users.findIndex((u) => u.LAST_SEEN_AT === null)
  expect(neverSeen).toBeGreaterThanOrEqual(0)
  expect(inserted[neverSeen]).not.toHaveProperty('LAST_SEEN_AT')
  expect<unknown>({ ...inserted[neverSeen], LAST_SEEN_AT: null }).toEqual(users[neverSeen])
})

test('load rejects rows that do not fit the table, and unsafe names', async () => {
  const client: Executor = { execute: async () => ({ queryId: 'q', columns: [], rows: [], totalRows: 0 }) }
  const [user] = generate().users
  await expect(load(client, 'TEST', userDomain, [{ ...user!, EMAIL: null }])).rejects.toThrow('USERS.EMAIL is required')
  await expect(load(client, 'TEST', userDomain, [{ ...user!, NICKNAME: 'x' }])).rejects.toThrow('USERS has no column NICKNAME')
  expect(() => createTableSql('TEST; drop table X', userDomain)).toThrow('Invalid Snowflake identifier')
  expect(createTableSql('TEST', taskDomain)).toContain("ASSIGNEE_ID number(38,0) comment 'USERS.ID of the assignee; null if unassigned'")
})
