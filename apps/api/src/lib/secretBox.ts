// Destination: apps/api/src/lib/secretBox.ts
//
// Encrypts small secrets at rest (the authenticator keys). AES-256-GCM, key
// derived from APP_SECRET in apps/api/.env, same scheme as Translatus's
// lib/crypto.ts.
//
// APP_SECRET: at least 32 random bytes, base64. Generate one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Keep it backed up and never change it: changing it makes every stored
// authenticator key unreadable, so everyone would have to be reset.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

let key: Buffer | null = null;

function getKey(): Buffer {
  if (key) return key;
  const raw = process.env.APP_SECRET?.trim();
  if (!raw) throw new Error('APP_SECRET is not set in apps/api/.env (needed for two-step sign-in)');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length < 32) throw new Error('APP_SECRET must be at least 32 random bytes, base64-encoded');
  key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'pipeline/secret-box/v1', 32));
  return key;
}

export function appSecretConfigured(): boolean {
  try { getKey(); return true; } catch { return false; }
}

const MAGIC = Buffer.from('PL01');

/** Layout: "PL01" | 12-byte IV | 16-byte tag | ciphertext. */
export function encrypt(data: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Uint8Array): Buffer {
  const b = Buffer.from(blob);
  if (b.length < 32 || !b.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted value');
  const d = createDecipheriv('aes-256-gcm', getKey(), b.subarray(4, 16));
  d.setAuthTag(b.subarray(16, 32));
  return Buffer.concat([d.update(b.subarray(32)), d.final()]);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
