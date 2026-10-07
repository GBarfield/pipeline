// Destination: apps/api/src/middleware/auth.ts
//
// requireAuth reads the session cookie, verifies the JWT, and then looks the
// user up in the DB on every request (rather than trusting the JWT's claims
// wholesale) so that deactivating a user or changing their role takes effect
// immediately instead of waiting for their token to expire. This app's
// traffic is small enough that the extra lookup is not a real cost.

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.ts';
import { SESSION_COOKIE, verifySessionToken } from '../lib/auth.ts';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'SUPER_USER' | 'BROKER_USER';
  brokerId: number | null;
  restrictedDivisionId: number | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = verifySessionToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
        req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      brokerId: user.brokerId,
      restrictedDivisionId: user.restrictedDivisionId,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

export function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}