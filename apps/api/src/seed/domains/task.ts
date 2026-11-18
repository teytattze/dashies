import { date, DAY_MS, type Domain, pick, pickWeighted, type Random, type Row, timestamp } from '../domain.ts'
import type { UserRow } from './user.ts'

export const taskDomain: Domain = {
  table: 'TASKS',
  comment: 'One row per task. ASSIGNEE_ID and CREATED_BY_ID reference USERS.ID. Sample data for testing.',
  columns: [
    { name: 'ID', type: 'number(38,0)', comment: 'Primary key' },
    { name: 'TITLE', type: 'varchar', comment: 'Short summary' },
    { name: 'STATUS', type: 'varchar', comment: 'todo, in_progress, in_review, done or cancelled' },
    { name: 'PRIORITY', type: 'varchar', comment: 'low, medium, high or urgent' },
    { name: 'PROJECT', type: 'varchar', comment: 'Project the task belongs to' },
    { name: 'ASSIGNEE_ID', type: 'number(38,0)', nullable: true, comment: 'USERS.ID of the assignee; null if unassigned' },
    { name: 'CREATED_BY_ID', type: 'number(38,0)', comment: 'USERS.ID of the creator' },
    { name: 'ESTIMATE_HOURS', type: 'number(6,1)', nullable: true, comment: 'Estimated effort in hours; null if not estimated' },
    { name: 'TAGS', type: 'array', comment: 'Labels, as an array of strings; empty if none' },
    { name: 'CREATED_AT', type: 'timestamp_ntz', comment: 'When the task was created (UTC)' },
    { name: 'DUE_DATE', type: 'date', nullable: true, comment: 'Deadline; null if none' },
    { name: 'COMPLETED_AT', type: 'timestamp_ntz', nullable: true, comment: 'When the task was done (UTC); set only when STATUS is done' },
  ],
}

export type TaskRow = Row & { ID: number; STATUS: string; CREATED_AT: string; COMPLETED_AT: string | null }

const VERBS = ['Fix', 'Add', 'Update', 'Review', 'Design', 'Investigate', 'Refactor', 'Document', 'Test', 'Migrate']
const SUBJECTS = ['login flow', 'billing page', 'onboarding emails', 'search results', 'export to CSV', 'mobile layout', 'API rate limits', 'pricing table', 'audit log', 'notification settings', 'dashboard filters', 'SSO setup']
const PROJECTS = ['Website', 'Mobile app', 'Billing', 'Platform', 'Growth', 'Internal tools']
const TAGS = ['bug', 'feature', 'chore', 'customer', 'tech-debt', 'security', 'design']
const ESTIMATES = [0.5, 1, 2, 3, 5, 8, 13, 21]

/**
 * Tasks created over the year before `now`, by and for `users`. IDs ascend
 * with creation time. Older tasks are mostly finished; recent ones mostly open.
 */
export function generateTasks(options: { count: number; now: Date; random: Random; users: UserRow[] }): TaskRow[] {
  const { count, random, users } = options
  if (users.length === 0) throw new Error('Tasks need at least one user')
  const now = options.now.getTime()
  const signups = users.map((u) => Date.parse(`${u.CREATED_AT}Z`))
  // No task predates the first user.
  const earliest = Math.max(now - 365 * DAY_MS, Math.min(...signups))
  const created = Array.from({ length: count }, () => earliest + random() * (now - earliest)).sort((a, b) => a - b)

  return created.map((createdAt, i) => {
    // Only people who had signed up by then can create or be given the task.
    const existing = users.filter((_, u) => signups[u]! <= createdAt)
    const active = existing.filter((u) => u.IS_ACTIVE)
    const ageDays = (now - createdAt) / DAY_MS

    let status = pickWeighted(
      random,
      ageDays > 30
        ? { todo: 1, in_progress: 1, in_review: 1, done: 14, cancelled: 2 }
        : { todo: 6, in_progress: 5, in_review: 3, done: 5, cancelled: 1 },
    )
    let completedAt: number | null = null
    if (status === 'done') {
      // Most tasks close within days; a few take weeks.
      completedAt = createdAt + (1 / 24 + random() ** 3 * 30) * DAY_MS
      if (completedAt > now) {
        status = 'in_progress'
        completedAt = null
      }
    }

    return {
      ID: i + 1,
      TITLE: `${pick(random, VERBS)} ${pick(random, SUBJECTS)}`,
      STATUS: status,
      PRIORITY: pickWeighted(random, { low: 3, medium: 5, high: 3, urgent: 1 }),
      PROJECT: pick(random, PROJECTS),
      ASSIGNEE_ID: random() < 0.88 ? pick(random, active.length > 0 ? active : existing).ID : null,
      CREATED_BY_ID: pick(random, existing).ID,
      ESTIMATE_HOURS: random() < 0.6 ? pick(random, ESTIMATES) : null,
      TAGS: TAGS.filter(() => random() < 0.2),
      CREATED_AT: timestamp(createdAt),
      DUE_DATE: random() < 0.7 ? date(createdAt + (1 + random() * 44) * DAY_MS) : null,
      COMPLETED_AT: completedAt === null ? null : timestamp(completedAt),
    }
  })
}
