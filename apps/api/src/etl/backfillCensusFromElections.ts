// Destination: apps/api/src/etl/backfillCensusFromElections.ts
//
// One-off backfill: reconstructs historical CommissionPeriod + CensusEntry
// rows for EN-covered groups from the full Election history each group's
// nightly EN scrape has always contained. Election is truncate-and-reloaded
// per group every night, but the source CSV is a COMPLETE export each time
// (confirmed with Gregg 2026-08-27), not an incremental one - so
// Election.startDate/endDate ranges already cover a group's full election
// history, not just what's active today. Nothing about the 2026-08-21
// TRUNCATE of Deal/CommissionPeriod touched Employee/Election - neither
// table has a foreign key into Deal or CommissionPeriod - so this history
// was never destroyed. Only the derived CommissionPeriod/CensusEntry rows
// were, and this script re-derives them.
//
// NOT a scheduled job. Run manually, once (or a few times while verifying).
// Never wire this into index.ts's in-process scheduler - it only ever
// targets months BEFORE the current one; the live nightly
// syncCensusFromElections.ts job already owns the current month and this
// script does not touch it or its rows.
//
// Differences from syncCensusFromElections.ts, both required because this
// targets a PAST, completed month instead of the still-in-progress current
// one:
//   1. Snapshot point is the LAST DAY of the target month, not "today" -
//      this is the commission-census-sync-design.md doc's original
//      framing (section 4), which the live job explicitly could not use
//      because its target month-end is always in the future. For a
//      completed historical month, month-end is in the past and well
//      defined, so this is the correct point-in-time snapshot to avoid
//      double-counting a mid-month carrier/plan switch - same reasoning
//      the live job applies to "today," just applied to a finished month.
//      Known accepted tradeoff, inherited unchanged from the live job:
//      an employee who both enrolled and fully terminated within the
//      target month (never in force at month-end) will not appear in
//      that month's snapshot. Worth eyeballing on the first test run.
//   2. sourceFile is tagged EN-BACKFILL:... (not EN-AUTO-SYNC:...) so
//      these rows are clearly distinguishable from the live nightly job's
//      writes. This also makes the delete-before-insert idempotency check
//      scoped correctly: re-running this script only ever touches rows
//      this script itself wrote for the exact period being reprocessed,
//      never the nightly job's EN-AUTO-SYNC: rows, never another period's
//      EN-BACKFILL: rows.
//
// Usage (run one group first and eyeball the results before running all):
//   <same runner used for loadElections.ts / syncCensusFromElections.ts> src/etl/backfillCensusFromElections.ts 168
//   <same runner> src/etl/backfillCensusFromElections.ts        (all EN-covered groups, once step above looks right)
import { pathToFileURL } from 'url';
import { prisma } from '../lib/prisma.ts';
import { resolveProductId } from '../lib/productMatch.ts';

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function lastDayOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function defaultLabel(periodMonth: Date): string {
  return periodMonth.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function employeeName(emp: { displayName: string | null; fullName: string | null; firstName: string | null; lastName: string | null } | null): string {
  if (!emp) return 'Unknown';
  return emp.displayName ?? emp.fullName ?? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || 'Unknown');
}

export interface BackfillSummary {
  groupsRequested: number;
  groupsProcessed: number;
  groupsFailed: number;
  monthsConsidered: number;
  monthsSkippedEmpty: number;
  periodsCreated: number;
  periodsSkippedExisting: number;
  periodsSkippedClosed: number;
  totalCensusRowsCreated: number;
  totalSkippedNoPremium: number;
}

export async function runBackfillCensusFromElections(onlyGroupId?: number): Promise<BackfillSummary> {
  const now = new Date();
  const currentMonth = firstOfMonth(now);
  const loadBatchId = `EN-BACKFILL-${now.toISOString()}`;

  // Same lookup-by-stable-key pattern the live job and commissionPeriods.ts
  // both already use for CommissionPeriod.divisionId (required, no default).
  const accounting = await prisma.division.findUniqueOrThrow({ where: { key: 'ACCOUNTING' } });

  const groupRows = await prisma.election.findMany({
    where: onlyGroupId ? { groupId: onlyGroupId } : undefined,
    distinct: ['groupId'],
    select: { groupId: true },
  });
  const groupIds = groupRows.map((g) => g.groupId);
  console.log(`[backfillCensusFromElections] ${groupIds.length} group(s) to process${onlyGroupId ? ` (filtered to group ${onlyGroupId})` : ''}`);

  const summary: BackfillSummary = {
    groupsRequested: groupIds.length,
    groupsProcessed: 0,
    groupsFailed: 0,
    monthsConsidered: 0,
    monthsSkippedEmpty: 0,
    periodsCreated: 0,
    periodsSkippedExisting: 0,
    periodsSkippedClosed: 0,
    totalCensusRowsCreated: 0,
    totalSkippedNoPremium: 0,
  };

  for (const groupId of groupIds) {
    // Same per-group isolation as the live job - one group's bad data must
    // never abort the run for the rest.
    try {
      const bounds = await prisma.election.aggregate({
        where: { groupId },
        _min: { startDate: true },
      });
      const earliestStart = bounds._min.startDate;
      if (!earliestStart) {
        console.warn(`[backfillCensusFromElections] group ${groupId}: no startDate on any election, skipping`);
        continue;
      }

      let month = firstOfMonth(earliestStart);
      const monthsToProcess: Date[] = [];
      while (month.getTime() < currentMonth.getTime()) {
        monthsToProcess.push(month);
        month = addMonths(month, 1);
      }

      console.log(`[backfillCensusFromElections] group ${groupId}: checking ${monthsToProcess.length} historical month(s) starting ${monthsToProcess[0]?.toISOString().slice(0, 10) ?? 'n/a'}`);

      for (const periodMonth of monthsToProcess) {
        summary.monthsConsidered++;
        const monthEnd = lastDayOfMonth(periodMonth);

        const elections = await prisma.election.findMany({
          where: {
            groupId,
            declineReason: null,
            startDate: { lte: monthEnd },
            OR: [{ endDate: null }, { endDate: { gte: monthEnd } }],
          },
          include: { employee: true },
        });

        if (elections.length === 0) {
          summary.monthsSkippedEmpty++;
          continue; // no one in force at month-end - don't create an empty period
        }

        let period = await prisma.commissionPeriod.findUnique({
          where: { groupId_periodMonth: { groupId, periodMonth } },
        });

        if (!period) {
          period = await prisma.commissionPeriod.create({
            data: { groupId, divisionId: accounting.id, periodMonth, label: defaultLabel(periodMonth), status: 'open' },
          });
          summary.periodsCreated++;
        } else {
          summary.periodsSkippedExisting++;
        }

        if (period.status !== 'open') {
          summary.periodsSkippedClosed++;
          continue; // never overwrite a period a human already closed/reconciled
        }

        const latestByEmployeePlan = new Map<string, (typeof elections)[number]>();
        for (const e of elections) {
          const key = `${e.employeeId ?? 'none'}::${e.plan ?? 'none'}`;
          const existing = latestByEmployeePlan.get(key);
          if (!existing || (e.startDate && (!existing.startDate || e.startDate > existing.startDate))) {
            latestByEmployeePlan.set(key, e);
          }
        }

        const rowsToCreate: any[] = [];
        let skippedForMonth = 0;

        for (const e of latestByEmployeePlan.values()) {
          let premium = e.totalMonthlyPlanCost !== null ? Number(e.totalMonthlyPlanCost) : null;
          if (premium === null && (e.eeMonthlyCost !== null || e.erMonthlyCost !== null)) {
            premium = (e.eeMonthlyCost !== null ? Number(e.eeMonthlyCost) : 0) + (e.erMonthlyCost !== null ? Number(e.erMonthlyCost) : 0);
          }
          if (premium === null) {
            skippedForMonth++;
            continue;
          }

          const productId = await resolveProductId(e.plan);

          rowsToCreate.push({
            periodId: period.id,
            sourceFile: `EN-BACKFILL:${loadBatchId}`,
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

        await prisma.censusEntry.deleteMany({
          where: { periodId: period.id, sourceFile: { startsWith: 'EN-BACKFILL:' } },
        });
        if (rowsToCreate.length > 0) {
          await prisma.censusEntry.createMany({ data: rowsToCreate });
        }

        summary.totalCensusRowsCreated += rowsToCreate.length;
        summary.totalSkippedNoPremium += skippedForMonth;

        console.log(`[backfillCensusFromElections] group ${groupId} / ${periodMonth.toISOString().slice(0, 10)}: ${rowsToCreate.length} census row(s)${skippedForMonth > 0 ? `, ${skippedForMonth} skipped (no premium)` : ''}`);
      }

      summary.groupsProcessed++;
    } catch (err) {
      summary.groupsFailed++;
      console.error(`[backfillCensusFromElections] group ${groupId}: FAILED - ${(err as Error).message}`);
    }
  }

  console.log('[backfillCensusFromElections] Done.', summary);
  return summary;
}

const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const arg = process.argv[2];
  const onlyGroupId = arg ? Number(arg) : undefined;
  runBackfillCensusFromElections(onlyGroupId)
    .catch((err) => {
      console.error('[backfillCensusFromElections] Fatal error:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}