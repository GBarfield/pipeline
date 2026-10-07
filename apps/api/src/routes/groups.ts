// Destination: apps/api/src/routes/groups.ts
//
// 2026-08-31: added the "last synced" timestamp Gregg asked to see next to
// each Group's name in the UI. Computed live from Election.loadedAt rather
// than stored on Group - loadElections.ts truncates and reloads a group's
// Election rows every time it syncs that group, so the newest loadedAt
// among a group's elections IS the last successful sync time, with no risk
// of drifting out of sync the way a separately-stamped column could (e.g.
// if some future code path updates Group.updatedAt without actually having
// synced anything). This is the same signal reconcileCoverage.ts already
// uses for its STALE check - just surfaced through the API for the first
// time here instead of only ever reaching a log file.
//
// CORRECTED 2026-08-31: first version of this file used Election.createdAt,
// which does not exist on this table (confirmed via \d "Election") - the
// real column is `loadedAt` (timestamp, not null, default CURRENT_TIMESTAMP,
// stamped by loadElections.ts on every load). That mistake made every
// /api/groups request throw and return a 500, which broke every page with a
// Group picker (Reconciliation, Accounting, etc.) - not just the Groups
// admin page itself. Fixed below.
//
// Batched as ONE groupBy call for the whole list (see crudFactory.ts's
// `augment` hook) rather than a per-group query - this list is ~293 rows
// and growing, so N+1 here would be a real, avoidable slowdown on every
// Groups page load.
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withLastSyncedAt(records: any[]) {
  if (records.length === 0) return records;
  const groupIds = records.map((r) => r.id);
  const synced = await prisma.election.groupBy({
    by: ['groupId'],
    where: { groupId: { in: groupIds } },
    _max: { loadedAt: true },
  });
  const lastSyncedById = new Map(synced.map((s) => [s.groupId, s._max.loadedAt]));
  // null (not undefined) for a group with zero Election rows - e.g. a
  // Marketing-onboarded group with no EN account at all - so the frontend
  // can tell "never synced" apart from "field missing."
  return records.map((r) => ({ ...r, lastSyncedAt: lastSyncedById.get(r.id) ?? null }));
}

export default createCrudRouter(prisma.group, {
  include: { broker: true, carrier: true },
  scope: (user) => (user.role === 'SUPER_USER' ? undefined : { brokerId: user.brokerId ?? -1 }),
  injectOnCreate: (user) => (user.role === 'SUPER_USER' ? {} : { brokerId: user.brokerId }),
  augment: withLastSyncedAt,
  // 2026-08-31: alphabetical by company name instead of creation order -
  // see crudFactory.ts's `orderBy` addition for why.
  orderBy: { company: 'asc' },
});