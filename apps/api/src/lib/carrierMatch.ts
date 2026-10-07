// Destination: apps/api/src/lib/carrierMatch.ts
//
// Ensures a carrier name has a matching row in the Carrier catalog,
// creating one inline if it doesn't - called at the point where a new
// carrierName first gets written (Election, CensusEntry,
// CommissionStatementEntry), instead of reconciling it later in a
// separate nightly batch job. Mirrors the naming/shape of the existing
// productMatch.ts and groupMatch.ts helpers in this same directory.
//
// Deliberately does a live DB check on every call rather than caching
// known carrier names in memory. This function is called from both a
// one-shot script (loadElections.ts, fresh process every run) and routes
// inside the long-lived BenAdminAPI service (commissionReconciliation.ts,
// commissionStatements.ts) - a process-lifetime cache in the API service
// would go stale the moment the nightly loader creates a carrier the
// running service doesn't know about yet, and since Carrier.name has no
// unique constraint, that staleness would silently create a duplicate
// row instead of erroring. A per-call query costs one small indexed-ish
// lookup per row, which is negligible at upload volumes (dozens/hundreds
// of rows per file, not millions).
//
// Residual risk, accepted: if the exact same brand-new carrier name
// appears twice within the same batch (e.g. two rows in one file, both
// resolving to a name that doesn't exist yet), both calls can find
// nothing and both create a row before either write lands - a narrow
// race, same category of risk already accepted for Group.company having
// no unique constraint. Worth a periodic glance at the Carriers admin
// screen for obvious near-duplicates, same caveat as the original
// backfill script.
import { prisma } from './prisma.ts';

export async function ensureCarrierExists(rawName: string | null | undefined): Promise<void> {
  const name = rawName?.trim();
  if (!name || name.toLowerCase() === 'unknown') return;

  const existing = await prisma.carrier.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) return;

  try {
    await prisma.carrier.create({ data: { name } });
  } catch (err) {
    // Don't let a hiccup here (or a future unique constraint added to
    // Carrier.name) blow up whatever Election/CensusEntry/
    // CommissionStatementEntry row triggered this call - that row being
    // saved matters more than the carrier catalog being perfectly clean.
    console.warn(`[ensureCarrierExists] Failed to create Carrier "${name}":`, err);
  }
}