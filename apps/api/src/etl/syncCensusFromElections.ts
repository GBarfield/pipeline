// Destination: apps/api/src/etl/syncCensusFromElections.ts
// Nightly job: derives CensusEntry rows for the current month from the
// Employee/Election tables the Elections Loader already populates. Run this
// AFTER loadElections.ts in the nightly chain - it reads whatever Election
// truncate-and-reloaded for each group that same night.
//
// Scope: only ever syncs the CURRENT month's CommissionPeriod per EN-covered
// group (auto-created if missing), and only for periods still status='open'
// - a closed/reconciled period is left alone. See
// commission-census-sync-design.md for the full field-mapping rationale.
//
// Snapshot semantics: an Election row counts if declineReason is null and
// it's in force "as of right now" (startDate <= today AND (endDate is null
// OR endDate >= today)) - not "in force sometime during the month," and not
// "in force at month-end" (the design doc's original framing, written before
// this job's scope was narrowed to only ever target the CURRENT, still-
// in-progress month - month-end for that month is in the future, so "as of
// today" is the actually-correct snapshot point here, and it still prevents
// double-counting a mid-month carrier/plan switch the same way).
import { pathToFileURL } from 'url';
import { prisma } from '../lib/prisma.ts';
import { resolveProductId } from '../lib/productMatch.ts';

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function defaultLabel(periodMonth: Date): string {
  return periodMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function employeeName(emp: { displayName: string | null; fullName: string | null; firstName: string | null; lastName: string | null } | null): string {
  if (!emp) return 'Unknown';
  return emp.displayName ?? emp.fullName ?? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Unknown');
}

export interface SyncCensusSummary {
  periodMonth: string;
  groupsFound: number;
  periodsCreated: number;
  periodsSkippedClosed: number;
  groupsProcessed: number;
  groupsFailed: number;
  totalCreated: number;
  totalSkipped: number;
}

// Exported so index.ts's in-process scheduler can call this directly
// right after a load that actually loaded something, instead of this
// only ever being invoked as a standalone script. This job had NO
// Windows Task Scheduler entry at all before today - it existed in the
// repo but never actually ran - so wiring it in here is what turns it on
// for the first time, not just relocating an existing schedule.
export async function runSyncCensusFromElections(): Promise<SyncCensusSummary> {
  const now = new Date();
  const periodMonth = firstOfMonth(now);
  const today = dateOnly(now);
  const loadBatchId = `EN-AUTO-SYNC-${now.toISOString()}`;

  console.log(`[syncCensusFromElections] Starting run for period ${periodMonth.toISOString().slice(0, 10)}`);

  // CommissionPeriod.divisionId is required (not nullable, no default) - every
  // EN-covered group is Accounting's, so this mirrors the exact pattern
  // commissionPeriods.ts's own POST route already uses (division looked up by
  // stable key, stamped onto the new row) rather than inventing a second
  // convention for the same field. This lookup is what was missing before -
  // the create() call below used to omit divisionId entirely, which is why
  // every single run since this job was wired in has thrown and aborted
  // before processing a single group (2026-08-23 finding).
  const accounting = await prisma.division.findUniqueOrThrow({ where: { key: 'ACCOUNTING' } });

  const groupRows = await prisma.election.findMany({
    distinct: ['groupId'],
    select: { groupId: true },
  });
  const groupIds = groupRows.map((g) => g.groupId);
  console.log(`[syncCensusFromElections] ${groupIds.length} EN-covered group(s) found`);

  let periodsCreated = 0;
  let periodsSkippedClosed = 0;
  let groupsProcessed = 0;
  let groupsFailed = 0;
  let totalCreated = 0;
  let totalSkipped = 0;

  for (const groupId of groupIds) {
    // Each group is isolated in its own try/catch - one group's failure
    // (bad data, an unexpected null, a future schema surprise) must not
    // abort the run for the other ~200+ groups the way the missing-
    // divisionId bug did for every group, every tick, since this job was
    // first wired in. Mirrors the per-file isolation loadElections.ts
    // already has for the same reason.
    try {
      let period = await prisma.commissionPeriod.findUnique({
        where: { groupId_periodMonth: { groupId, periodMonth } },
      });

      if (!period) {
        period = await prisma.commissionPeriod.create({
          data: { groupId, divisionId: accounting.id, periodMonth, label: defaultLabel(periodMonth), status: 'open' },
        });
        periodsCreated++;
      }

      if (period.status !== 'open') {
        periodsSkippedClosed++;
        continue;
      }

      const elections = await prisma.election.findMany({
        where: {
          groupId,
          declineReason: null,
          startDate: { lte: today },
          OR: [{ endDate: null }, { endDate: { gte: today } }],
        },
        include: { employee: true },
      });

      // Guard against duplicate active rows for the same employee+plan
      // (shouldn't normally happen given the as-of-today filter, but Election
      // is raw EN export data - don't trust it blindly). Latest startDate wins.
      const latestByEmployeePlan = new Map<string, (typeof elections)[number]>();
      for (const e of elections) {
        const key = `${e.employeeId ?? 'none'}::${e.plan ?? 'none'}`;
        const existing = latestByEmployeePlan.get(key);
        if (!existing || (e.startDate && (!existing.startDate || e.startDate > existing.startDate))) {
          latestByEmployeePlan.set(key, e);
        }
      }

      const rowsToCreate: any[] = [];
      let skippedForGroup = 0;

      for (const e of latestByEmployeePlan.values()) {
        let premium = e.totalMonthlyPlanCost !== null ? Number(e.totalMonthlyPlanCost) : null;
        if (premium === null && (e.eeMonthlyCost !== null || e.erMonthlyCost !== null)) {
          premium = (e.eeMonthlyCost !== null ? Number(e.eeMonthlyCost) : 0) + (e.erMonthlyCost !== null ? Number(e.erMonthlyCost) : 0);
        }
        if (premium === null) {
          skippedForGroup++;
          continue;
        }

        const productId = await resolveProductId(e.plan);

        rowsToCreate.push({
          periodId: period.id,
          sourceFile: `EN-AUTO-SYNC:${loadBatchId}`,
          employeeName: employeeName(e.employee),
          carrierName: e.carrier || 'Unknown',
          productId,
          productLabel: e.plan ?? null,
          planName: e.benefit ?? null,
          coverageTier: e.coverageLevel ?? null,
          premium,
          rawRow: e.rawRow as any,
        });
      }

      // Idempotent re-run: only ever touches rows this job itself wrote for
      // this period (sourceFile prefix), never manually-uploaded CensusEntry
      // rows - same truncate-and-reload-per-group pattern the Elections Loader
      // already uses on Election itself.
      await prisma.censusEntry.deleteMany({
        where: { periodId: period.id, sourceFile: { startsWith: 'EN-AUTO-SYNC:' } },
      });
      if (rowsToCreate.length > 0) {
        await prisma.censusEntry.createMany({ data: rowsToCreate });
      }

      groupsProcessed++;
      totalCreated += rowsToCreate.length;
      totalSkipped += skippedForGroup;

      if (skippedForGroup > 0) {
        console.warn(`[syncCensusFromElections] group ${groupId}: skipped ${skippedForGroup} election(s) with no usable premium`);
      }
    } catch (err) {
      groupsFailed++;
      console.error(`[syncCensusFromElections] group ${groupId}: FAILED - ${(err as Error).message}`);
    }
  }

  console.log(
    `[syncCensusFromElections] Done. groups=${groupsProcessed} failed=${groupsFailed} periodsCreated=${periodsCreated} periodsSkippedClosed=${periodsSkippedClosed} censusRowsCreated=${totalCreated} skipped=${totalSkipped}`
  );

  return {
    periodMonth: periodMonth.toISOString().slice(0, 10),
    groupsFound: groupIds.length,
    periodsCreated,
    periodsSkippedClosed,
    groupsProcessed,
    groupsFailed,
    totalCreated,
    totalSkipped,
  };
}

// CLI entry point - only runs when this file is executed directly. Same
// reasoning as loadElections.ts: runSyncCensusFromElections() is now
// ALSO called in-process by index.ts's scheduler, and prisma.$disconnect()
// must never fire on that path - it would tear down the shared Prisma
// client the whole API server depends on.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runSyncCensusFromElections()
    .catch((err) => {
      console.error('[syncCensusFromElections] Fatal error:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}