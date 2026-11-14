// Destination: apps/api/src/lib/auth.ts
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — add it to apps/api/.env');
}

const TOKEN_TTL = '12h';
export const SESSION_COOKIE = 'pipeline_session';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface SessionPayload {
  sub: number; // User.id
  // User.sessionVersion when the session was made. requireAuth refuses a
  // token whose sv doesn't match (or is missing), so bumping the user's
  // sessionVersion signs them out everywhere. Tokens issued before two-step
  // sign-in existed have no sv, so everyone signs in again (with a code) once.
  sv: number;
}

export function signSessionToken(userId: number, sessionVersion: number): string {
  return jwt.sign({ sub: userId, sv: sessionVersion } satisfies SessionPayload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, JWT_SECRET) as SessionPayload;
}