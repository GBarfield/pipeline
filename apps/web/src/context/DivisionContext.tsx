import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export interface Division {
  id: number;
  key: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

interface DivisionContextValue {
  currentDivision: Division | null;
  divisions: Division[];
  loading: boolean;
  setDivision: (divisionId: number) => Promise<void>;
}

const DivisionContext = createContext<DivisionContextValue | undefined>(undefined);

// Where each division's dashboard page lives. Keep this in sync with the
// seeded Division.key values (apps/api/prisma/seed.ts) and the routes
// registered in App.tsx. Exported so App.tsx can point the "Dashboard" nav
// entry and the "/" redirect at the same paths without duplicating this map.
export const DASHBOARD_PATH: Record<string, string> = {
  MARKETING: '/marketing/dashboard',
  ACCOUNTING: '/accounting/dashboard',
  BENEFITS_ADMINISTRATION: '/benefits-administration/dashboard',
};

// Marketing was the app's original (and long the only) division, so it's
// the sane fallback if a division key is missing or not yet recognized here.
const DEFAULT_DASHBOARD_PATH = DASHBOARD_PATH.MARKETING;

export function getDashboardPath(divisionKey: string | null | undefined): string {
  if (divisionKey && DASHBOARD_PATH[divisionKey]) return DASHBOARD_PATH[divisionKey];
  return DEFAULT_DASHBOARD_PATH;
}

export function DivisionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [currentDivision, setCurrentDivision] = useState<Division | null>(null);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const [currentRes, listRes] = await Promise.all([
        fetch('/api/divisions/current'),
        fetch('/api/divisions'),
      ]);
      if (!cancelled && currentRes.ok) setCurrentDivision(await currentRes.json());
      if (!cancelled && listRes.ok) setDivisions(await listRes.json());
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const setDivision = useCallback(async (divisionId: number) => {
    const res = await fetch('/api/divisions/current', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ divisionId }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCurrentDivision(updated);
      // Switching divisions changes what the side menu shows, but the URL
      // (and therefore the routed page in the Content area) doesn't change
      // on its own - always land on the new division's own dashboard so the
      // body never gets stranded on a page the new division doesn't expose.
      navigate(getDashboardPath(updated.key));
    }
  }, [navigate]);

  return (
    <DivisionContext.Provider value={{ currentDivision, divisions, loading, setDivision }}>
      {children}
    </DivisionContext.Provider>
  );
}

export function useDivision() {
  const ctx = useContext(DivisionContext);
  if (!ctx) throw new Error('useDivision must be used within a DivisionProvider');
  return ctx;
}
