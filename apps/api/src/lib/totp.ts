// Destination: apps/api/src/lib/totp.ts
//
// Copied from Translatus (C:\translator apps/web/lib/totp.ts) so both apps
// behave the same. Only changes: the issuer name and the removal of
// Translatus's local-test switch (TWO_STEP_OFF), which PipeLine doesn't use.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA1, 6 digits, a new code every 30 seconds.
 * Every authenticator app (Google, Microsoft, Authy, 1Password…) understands these settings. Pure: no database.
 */

export const PERIOD = 30;
export const DIGITS = 6;
/** Codes from one step before or after are accepted too, for phone clocks that are a little off. */
export const WINDOW = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a base32 key.");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new key: 20 random bytes, 32 base32 letters. */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / PERIOD);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** "123 456", " 123456 " → "123456"; anything else → null. */
export function cleanCode(raw: string): string | null {
  const c = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(c) ? c : null;
}

/**
 * The step the code matches, or null. A step at or before `lastStep` is refused, so a code
 * someone has seen over a shoulder can't be used again.
 */
export function matchStep(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const now = stepAt(nowMs);
  const want = Buffer.from(code);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue;
    const got = Buffer.from(codeAt(secret, step));
    if (got.length === want.length && timingSafeEqual(got, want)) return step;
  }
  return null;
}

/** What the QR code holds: otpauth://totp/PipeLine:jane%40acme.com?secret=…&issuer=PipeLine… */
export function otpauthUri(secret: string, account: string, issuer = "PipeLine"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/** "ABCD EFGH IJKL …" for typing into the app by hand. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
