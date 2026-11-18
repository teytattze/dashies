import { DAY_MS, type Domain, pick, pickWeighted, type Random, type Row, timestamp } from '../domain.ts'

export const userDomain: Domain = {
  table: 'USERS',
  comment: 'One row per person with an account. Sample data for testing.',
  columns: [
    { name: 'ID', type: 'number(38,0)', comment: 'Primary key' },
    { name: 'EMAIL', type: 'varchar', comment: 'Unique' },
    { name: 'NAME', type: 'varchar', comment: 'Full name' },
    { name: 'ROLE', type: 'varchar', comment: 'admin, member or guest' },
    { name: 'TEAM', type: 'varchar', comment: 'Team the user works in' },
    { name: 'COUNTRY', type: 'varchar', comment: 'ISO 3166-1 alpha-2 country code' },
    { name: 'IS_ACTIVE', type: 'boolean', comment: 'False once the account is deactivated' },
    { name: 'CREATED_AT', type: 'timestamp_ntz', comment: 'When the user signed up (UTC)' },
    { name: 'LAST_SEEN_AT', type: 'timestamp_ntz', nullable: true, comment: 'Last activity (UTC); null if never signed in' },
  ],
}

export type UserRow = Row & { ID: number; CREATED_AT: string; IS_ACTIVE: boolean }

const FIRST_NAMES = ['Ada', 'Ben', 'Chloe', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Imani', 'Jonas', 'Keiko', 'Liam', 'Mei', 'Noah', 'Olga', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Yara', 'Zoe']
const LAST_NAMES = ['Adams', 'Brown', 'Chen', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Haddad', 'Ito', 'Jensen', 'Khan', 'Lopez', 'Mwangi', 'Nguyen', 'Okafor', 'Patel', 'Rossi', 'Singh', 'Tan', 'Weber']
export const TEAMS = ['Engineering', 'Design', 'Product', 'Marketing', 'Sales', 'Support'] as const

/** Sign-ups over the two years before `now`, more of them recent. IDs ascend with sign-up time. */
export function generateUsers(options: { count: number; now: Date; random: Random }): UserRow[] {
  const { count, random } = options
  const now = options.now.getTime()
  const signups = Array.from({ length: count }, () => now - random() ** 2 * 730 * DAY_MS).sort((a, b) => a - b)

  const emails = new Set<string>()
  return signups.map((createdAt, i) => {
    const first = pick(random, FIRST_NAMES)
    const last = pick(random, LAST_NAMES)
    let email = `${first}.${last}@example.com`.toLowerCase()
    if (emails.has(email)) email = `${first}.${last}${i + 1}@example.com`.toLowerCase()
    emails.add(email)

    const isActive = random() < 0.85
    const neverSeen = random() < 0.08
    // Deactivated users were last seen some time ago; active ones mostly within the last weeks.
    const idle = (isActive ? random() ** 3 : random()) * (now - createdAt)
    return {
      ID: i + 1,
      EMAIL: email,
      NAME: `${first} ${last}`,
      ROLE: pickWeighted(random, { admin: 1, member: 8, guest: 2 }),
      TEAM: pickWeighted(random, { Engineering: 6, Design: 2, Product: 2, Marketing: 2, Sales: 3, Support: 3 } satisfies Record<(typeof TEAMS)[number], number>),
      COUNTRY: pickWeighted(random, { US: 8, GB: 3, DE: 3, FR: 2, IN: 3, SG: 2, MY: 2, JP: 2, BR: 2, AU: 1 }),
      IS_ACTIVE: isActive,
      CREATED_AT: timestamp(createdAt),
      LAST_SEEN_AT: neverSeen ? null : timestamp(now - idle),
    }
  })
}
