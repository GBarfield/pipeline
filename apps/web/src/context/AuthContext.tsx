import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'SUPER_USER' | 'BROKER_USER';
  brokerId: number | null;
}

// Sign-in is two steps (see apps/api/src/lib/twoStep.ts): login() checks the
// password and says which second step comes next; submitCode() finishes it
// and signs in.
export type NextStep = 'code' | 'setup';

export class SignInError extends Error {
  restart: boolean;
  constructor(message: string, restart = false) {
    super(message);
    this.restart = restart;
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<NextStep>;
  submitCode: (code: string) => Promise<{ enrolled: boolean }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      setUser(res.ok ? await res.json() : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function login(email: string, password: string): Promise<NextStep> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new SignInError(body.error || 'Login failed');
    return body.next as NextStep;
  }

  async function submitCode(code: string): Promise<{ enrolled: boolean }> {
    const res = await fetch('/api/auth/two-step', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new SignInError(body.error || 'Sign-in failed', !!body.restart);
    const { enrolled, ...u } = body;
    setUser(u as AuthUser);
    return { enrolled: !!enrolled };
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, submitCode, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}