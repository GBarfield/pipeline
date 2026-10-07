import crypto from "crypto";

/**
 * SSNs are government ID numbers. By default we never store the raw value --
 * we store a salted SHA-256 hash (for exact-match lookups, e.g. joining
 * against a future employee table) plus the last 4 digits (for support-desk
 * "confirm the last 4" style lookups).
 *
 * SSN_PEPPER must be set in the environment (a long random secret, NOT
 * committed to source control) and kept stable -- if it ever changes, every
 * previously-hashed SSN becomes unmatchable against new hashes.
 *
 * Set STORE_SSN_PLAINTEXT=true only if your compliance/legal review calls
 * for it; see config.ts.
 */

function normalizeSsn(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

export function hashSsn(raw: string, pepper: string): { hash: string; last4: string } | null {
  const digits = normalizeSsn(raw);
  if (digits.length !== 9) {
    return null; // not a real SSN-shaped value; caller should log a warning
  }
  const hash = crypto.createHmac("sha256", pepper).update(digits).digest("hex");
  const last4 = digits.slice(-4);
  return { hash, last4 };
}
