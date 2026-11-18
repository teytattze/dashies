import { decryptSecret } from '../crypto.ts'
import type { dataSources } from '../db/schema.ts'
import { SnowflakeClient } from './client.ts'

/** Opens a client for a stored data source, decrypting its access token. */
export async function connect(source: typeof dataSources.$inferSelect): Promise<SnowflakeClient> {
  if (!source.encryptedCredentials) throw new Error(`Data source "${source.name}" has no credentials`)
  return new SnowflakeClient({
    config: source.config,
    token: await decryptSecret(source.encryptedCredentials),
  })
}
