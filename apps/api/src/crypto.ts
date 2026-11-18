/**
 * Encryption for secrets stored in the app database (data source credentials).
 * AES-256-GCM with a key from the `CREDENTIALS_KEY` env var: 32 random bytes,
 * base64-encoded (`openssl rand -base64 32`).
 */

const IV_BYTES = 12

async function key(): Promise<CryptoKey> {
  const raw = Buffer.from(process.env.CREDENTIALS_KEY ?? '', 'base64')
  if (raw.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Returns base64 of a fresh IV followed by the ciphertext. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(plaintext))
  return Buffer.concat([iv, new Uint8Array(data)]).toString('base64')
}

export async function decryptSecret(encrypted: string): Promise<string> {
  const bytes = Buffer.from(encrypted, 'base64')
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) },
    await key(),
    bytes.subarray(IV_BYTES),
  )
  return new TextDecoder().decode(data)
}
