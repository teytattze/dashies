import type { LookupOption } from './db/types.ts'
import { LOOKUP_MAX_OPTIONS, lookupOptions } from './query/compile.ts'
import type { Executor } from './snowflake/catalog.ts'

/**
 * The options of lookup filters, read from the warehouse. Unlike a run this
 * waits for the statement: its result is needed before a run's SQL can be
 * written. `sql` is what `compileLookup` wrote: the distinct values of one
 * expression over a chart's base rows.
 */

/** How long options are served from memory before the warehouse is asked again. */
export const LOOKUP_TTL_MS = 60_000

/** Reads a lookup's options. `truncated` = it returned more rows than a filter offers; the rest are left out. */
export async function readLookup(client: Executor, sql: string): Promise<{ options: LookupOption[]; truncated: boolean }> {
  const { rows } = await client.execute(sql, [], { maxRows: LOOKUP_MAX_OPTIONS + 1 })
  return { options: lookupOptions(rows), truncated: rows.length > LOOKUP_MAX_OPTIONS }
}

const cache = new Map<string, { options: Promise<LookupOption[]>; expires: number }>()

/**
 * A lookup's options, from memory if they were read less than `LOOKUP_TTL_MS`
 * ago. `scope` separates data sources, whose tables differ.
 */
export function cachedLookup(scope: string, client: Executor, sql: string, now = Date.now()): Promise<LookupOption[]> {
  const key = JSON.stringify([scope, sql])
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.options
  for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k)
  const options = readLookup(client, sql).then((read) => read.options)
  cache.set(key, { options, expires: now + LOOKUP_TTL_MS })
  // A failed read is not remembered.
  options.catch(() => cache.get(key)?.options === options && cache.delete(key))
  return options
}

/** Makes the next read of every lookup ask the warehouse. */
export const forgetLookups = () => cache.clear()
