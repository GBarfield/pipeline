// Destination: apps/api/src/etl/reconcileCoverage.ts
//
// Nightly coverage-reconciliation check. This does not fix anything by
// itself - it surfaces the two failure classes that let "Teamsters LOCAL
// 1932 Union" go missing for two days without anyone noticing:
//
//   1. STALE GROUPS - a Group that has downloaded successfully before but
//      has gone quiet (no fresh Election row loaded within the staleness
//      window below). This is the "was in the Aug 21 data, gone by Aug 23"
//      pattern - a download failed silently and nothing said so.
//   2. UNRESOLVED HOLDS - files currently sitting in config.failedDir's
//      dated subfolders because loadElections.ts flagged them as a
//      possible_duplicate or ambiguous match and parked them for manual
//      review instead of loading them. These are not retried automatically
//      and never show up anywhere in the UI.
//
// Called from index.ts's cron block after a successful runLoadElections()
// tick. Writes a plain-language summary to console (the same stream NSSM
// captures to service-stdout.log), so `Get-Content service-stdout.log
// -Tail 100` surfaces problems without needing a new dashboard screen.

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.ts';
import { config } from './config.ts';

// A Group counts as "stale" if EN has delivered data for it before, but
// nothing has loaded in this many hours. 30 hours (not 24) gives one full
// extra nightly-run cycle of slack before flagging - a single skipped
// night from a known transient cause (e.g. a TOTP failure) shouldn't fire
// an alarm the very next check; two skipped nights in a row should.
const STALE_HOURS_THRESHOLD = 30;

export interface StaleGroup {
  groupId: number;
  company: string;
  lastLoadedAt: Date;
  hoursSinceLastLoad: number;
}

export interface UnresolvedHold {
  fileName: string;
  folder: string;
}

export interface ReconciliationResult {
  staleGroups: StaleGroup[];
  unresolvedHolds: UnresolvedHold[];
}

async function findStaleGroups(): Promise<StaleGroup[]> {
  // Raw SQL: computing MAX(loadedAt) + age in Postgres is far cheaper than
  // pulling every Election row into Node to do the same math in JS on
  // every single tick across 200+ groups.
  const rows = await prisma.$queryRaw<
    { groupId: number; company: string; lastLoadedAt: Date; hoursSinceLastLoad: number }[]
  >`
    SELECT g.id AS "groupId", g.company, MAX(e."loadedAt") AS "lastLoadedAt",
           EXTRACT(EPOCH FROM (now() - MAX(e."loadedAt"))) / 3600 AS "hoursSinceLastLoad"
    FROM "Group" g
    JOIN "Election" e ON e."groupId" = g.id
    WHERE g.archived = false
    GROUP BY g.id, g.company
    HAVING EXTRACT(EPOCH FROM (now() - MAX(e."loadedAt"))) / 3600 > ${STALE_HOURS_THRESHOLD}
    ORDER BY "hoursSinceLastLoad" DESC
  `;
  return rows.map((r) => ({
    groupId: r.groupId,
    company: r.company,
    lastLoadedAt: r.lastLoadedAt,
    hoursSinceLastLoad: Math.round(Number(r.hoursSinceLastLoad)),
  }));
}

function findUnresolvedHolds(): UnresolvedHold[] {
  const holds: UnresolvedHold[] = [];
  if (!fs.existsSync(config.failedDir)) return holds;

  // Held files live under failedDir/<YYYY-MM-DD>/. Check every dated
  // subfolder still present, not just today's - a hold from two nights ago
  // that nobody has resolved yet is exactly what this check exists to catch.
  const dateFolders = fs
    .readdirSync(config.failedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dateFolder of dateFolders) {
    const folderPath = path.join(config.failedDir, dateFolder.name);
    const files = fs.readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith('.csv'));
    for (const fileName of files) {
      holds.push({ fileName, folder: dateFolder.name });
    }
  }
  return holds;
}

export async function reconcileGroupCoverage(): Promise<ReconciliationResult> {
  const [staleGroups, unresolvedHolds] = await Promise.all([
    findStaleGroups(),
    Promise.resolve(findUnresolvedHolds()),
  ]);

  if (staleGroups.length === 0 && unresolvedHolds.length === 0) {
    console.log('[reconcileCoverage] OK - no stale groups, no unresolved holds.');
    return { staleGroups, unresolvedHolds };
  }

  console.warn(
    `[reconcileCoverage] ATTENTION - ${staleGroups.length} stale group(s), ${unresolvedHolds.length} unresolved hold(s).`,
  );

  for (const g of staleGroups) {
    console.warn(
      `[reconcileCoverage] STALE: group #${g.groupId} "${g.company}" - last loaded ${g.hoursSinceLastLoad}h ago (${g.lastLoadedAt.toISOString()}).`,
    );
  }
  for (const h of unresolvedHolds) {
    console.warn(
      `[reconcileCoverage] UNRESOLVED HOLD: "${h.fileName}" sitting in failed/${h.folder}/ - check possible-duplicates.log for why.`,
    );
  }

  return { staleGroups, unresolvedHolds };
}