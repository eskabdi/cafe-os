// Kiosk device token helpers. Pure (Web Crypto only). The token is 64 lowercase hex characters (32 random bytes, issued once
// by fn_register_kiosk); the database stores only sha256(token text) as lowercase hex, exactly what kioskTokenHash returns.
// Never log a token or its hash.

export const KIOSK_TOKEN_RE = /^[0-9a-f]{64}$/

export async function kioskTokenHash(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
