import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { prisma } from "../lib/prisma.ts";
import { config } from "./config.ts";
import { parseElectionCsv } from "./csv.ts";
import { buildGroupIndex, deriveGroupNameFromFilename, matchOrCreateGroup } from "./groupMatch.ts";
import { ensureCarrierExists } from "../lib/carrierMatch.ts";

interface FileOutcome {
  file: string;
  groupNameFromFile: string;
  status: "loaded" | "ambiguous" | "possible_duplicate" | "parse_error" | "load_error";
  possibleDuplicateGroupId?: number;
  possibleDuplicateGroupName?: string;
  similarityScore?: number;
  groupId?: number;
  groupName?: string;
  matchType?: string;
  employeesUpserted?: number;
  rowsLoaded?: number;
  rowsSkippedBlank?: number;
  rowsWithoutEmployee?: number;
  unmappedHeaders?: string[];
  warnings?: string[];
  error?: string;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

async function moveFile(src: string, destDir: string) {
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(src));
  await fs.promises.rename(src, dest);
}

export interface LoadElectionsSummary {
  batchId: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  dryRun: boolean;
  filesTotal: number;
  filesLoaded: number;
  filesFailed: number;
  totalRowsLoaded: number;
  totalEmployeesUpserted: number;
  outcomes: FileOutcome[];
}

// Exported so index.ts's in-process scheduler can call this directly,
// instead of this file only ever running as a standalone `node
// src/etl/loadElections.ts` process invoked by Task Scheduler. Returns
// null when it bails out early (no fresh completion flag from the EN
// downloader) rather than a summary - callers should treat null as
// "nothing to do this tick," not an error.
export async function runLoadElections(): Promise<LoadElectionsSummary | null> {
  const batchId = crypto.randomUUID();
  const startedAt = new Date();

  ensureDir(config.logDir);

  const flagGateLogPath = path.join(config.logDir, "flag-gate.log");
  function logGate(msg: string) {
    fs.appendFileSync(flagGateLogPath, `${new Date().toISOString()} | ${msg}\n`);
    console.log(`[${batchId}] ${msg}`);
  }

  if (!fs.existsSync(config.downloadFlagPath)) {
    logGate(`SKIP: no completion flag at ${config.downloadFlagPath} -- downloader hasn't finished (or hasn't run) yet.`);
    return null;
  }

  const flagStat = fs.statSync(config.downloadFlagPath);
  const flagAgeHours = (Date.now() - flagStat.mtime.getTime()) / (1000 * 60 * 60);
  if (flagAgeHours > config.downloadFlagMaxAgeHours) {
    logGate(`SKIP: completion flag at ${config.downloadFlagPath} is stale (written ${flagStat.mtime.toISOString()}, ${flagAgeHours.toFixed(1)}h old, max age ${config.downloadFlagMaxAgeHours}h) -- possible downloader failure.`);
    return null;
  }

  logGate(`Proceeding: completion flag found (written ${flagStat.mtime.toISOString()}, ${flagAgeHours.toFixed(1)}h old).`);

  ensureDir(config.archiveDir);
  ensureDir(config.failedDir);

  if (!fs.existsSync(config.inputDir)) {
    throw new Error(`Input directory does not exist: ${config.inputDir}`);
  }

  // Chrome downloads straight into this folder. A file still named "AdHocReport..." was never renamed to
  // its company: either Pipeline's rename failed, or it's a Translatus report (the Translatus ENav robot
  // uses the same browser and moves its files out within seconds). Never load those - they'd create a junk
  // "AdHocReport_..." group, and a Translatus report carries SSNs for another purpose.
  const allCsv = fs
    .readdirSync(config.inputDir)
    .filter((f) => f.toLowerCase().endsWith(".csv"));
  const unrenamed = allCsv.filter((f) => /^adhocreport/i.test(f));
  if (unrenamed.length) {
    logGate(`SKIPPED ${unrenamed.length} file(s) never renamed to a company (left in place): ${unrenamed.join(", ")}`);
  }
  const files = allCsv
    .filter((f) => !/^adhocreport/i.test(f))
    .map((f) => path.join(config.inputDir, f));

  console.log(`[${batchId}] Found ${files.length} CSV file(s) in ${config.inputDir}${config.dryRun ? " (DRY RUN)" : ""}`);

  const groupIndex = await buildGroupIndex(prisma);
  const outcomes: FileOutcome[] = [];

  for (const file of files) {
        const groupNameFromFile = deriveGroupNameFromFilename(file);
    const match = await matchOrCreateGroup(groupIndex, prisma, groupNameFromFile, {
      dryRun: config.dryRun,
      similarityThreshold: config.groupSimilarityThreshold,
    });

    if (match.status === "ambiguous") {
      const names = match.candidates.map((c) => `${c.id}:${c.name}`).join(", ");
      console.error(`[${batchId}] AMBIGUOUS group for file "${path.basename(file)}" -- candidates: ${names}`);
      outcomes.push({ file: path.basename(file), groupNameFromFile, status: "ambiguous" });
      if (!config.dryRun) await moveFile(file, path.join(config.failedDir, todayStamp()));
      continue;
    }
    if (match.status === "possible_duplicate") {
      const pct = Math.round(match.similarityScore * 100);
      const msg = `POSSIBLE DUPLICATE for file "${path.basename(file)}" (derived name: "${groupNameFromFile}") -- ${pct}% similar to existing group #${match.possibleDuplicateOf.groupId} "${match.possibleDuplicateOf.groupName}". Held for manual review.`;
      console.error(`[${batchId}] ${msg}`);
      fs.appendFileSync(path.join(config.logDir, "possible-duplicates.log"), `${new Date().toISOString()} | ${msg}\n`);
      outcomes.push({
        file: path.basename(file),
        groupNameFromFile,
        status: "possible_duplicate",
        possibleDuplicateGroupId: match.possibleDuplicateOf.groupId,
        possibleDuplicateGroupName: match.possibleDuplicateOf.groupName,
        similarityScore: match.similarityScore,
      });
      if (!config.dryRun) await moveFile(file, path.join(config.failedDir, todayStamp()));
      continue;
    }
    if (match.matchType === "auto_created" || match.matchType === "would_auto_create") {
      const prefix = match.matchType === "would_auto_create" ? "(DRY RUN) Would auto-create" : "AUTO-CREATED";
      console.log(`[${batchId}] ${prefix} new group #${match.groupId} "${match.groupName}" for file "${path.basename(file)}"`);
    }

    let parsed;
    try {
      parsed = parseElectionCsv(file);
    } catch (err) {
      console.error(`[${batchId}] PARSE ERROR for "${path.basename(file)}": ${(err as Error).message}`);
      outcomes.push({ file: path.basename(file), groupNameFromFile, status: "parse_error", error: (err as Error).message });
      if (!config.dryRun) await moveFile(file, path.join(config.failedDir, todayStamp()));
      continue;
    }

    const fileName = path.basename(file);
    const rowsWithoutEmployee = parsed.elections.filter((r) => !r.employeeSsnHash).length;

    // Register any carrier name in this file that isn't in the Carrier
    // catalog yet - inline, at the earliest point a new carrier can enter
    // the system, rather than reconciling it later in a separate nightly
    // job. NOTE: assumes parseElectionCsv maps the carrier column to
    // `fields.carrier` (matching Election.carrier) - if that key is
    // actually named differently in csv.ts, swap it below.
    if (!config.dryRun) {
      const distinctCarriers = new Set(
        parsed.elections
          .map((row) => (row.fields as Record<string, unknown>)?.carrier)
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      );
      for (const carrierName of distinctCarriers) {
        await ensureCarrierExists(carrierName);
      }
    }

    try {
      let employeesUpserted = 0;
      if (!config.dryRun) {
        await prisma.$transaction(async (tx) => {
          const ssnHashToId = new Map<string, number>();
          for (const emp of parsed.employees.values()) {
            const row = await tx.employee.upsert({
              where: { groupId_employeeSsnHash: { groupId: match.groupId, employeeSsnHash: emp.employeeSsnHash } },
              update: {
                employeeSsnLast4: emp.employeeSsnLast4,
                employeeSsnPlaintext: emp.employeeSsnPlaintext,
                rawRow: emp.rawRow as any,
                sourceFileName: fileName,
                loadBatchId: batchId,
                ...(emp.fields as Record<string, unknown>),
              },
              create: {
                groupId: match.groupId,
                employeeSsnHash: emp.employeeSsnHash,
                employeeSsnLast4: emp.employeeSsnLast4,
                employeeSsnPlaintext: emp.employeeSsnPlaintext,
                rawRow: emp.rawRow as any,
                sourceFileName: fileName,
                loadBatchId: batchId,
                ...(emp.fields as Record<string, unknown>),
              },
              select: { id: true },
            });
            ssnHashToId.set(emp.employeeSsnHash, row.id);
          }
          employeesUpserted = ssnHashToId.size;

          const createData = parsed.elections.map((row) => ({
            groupId: match.groupId,
            employeeId: row.employeeSsnHash ? ssnHashToId.get(row.employeeSsnHash) ?? null : null,
            groupNameRaw: groupNameFromFile,
            sourceFileName: fileName,
            loadBatchId: batchId,
            rawRow: row.rawRow as any,
            ...(row.fields as Record<string, unknown>),
          }));

                    await tx.election.deleteMany({ where: { groupId: match.groupId } });
          await tx.election.createMany({ data: createData as any });
        }, { timeout: 120000, maxWait: 10000 });
        await moveFile(file, path.join(config.archiveDir, todayStamp()));
      } else {
        employeesUpserted = parsed.employees.size;
      }

      console.log(`[${batchId}] Loaded ${parsed.elections.length} row(s) / ${employeesUpserted} employee(s) for group "${match.groupName}" (${match.matchType} match) from "${fileName}"`);
      outcomes.push({
        file: fileName,
        groupNameFromFile,
        status: "loaded",
        groupId: match.groupId,
        groupName: match.groupName,
        matchType: match.matchType,
        employeesUpserted,
        rowsLoaded: parsed.elections.length,
        rowsSkippedBlank: parsed.skippedBlankRows,
        rowsWithoutEmployee,
        unmappedHeaders: parsed.unmappedHeaders,
        warnings: parsed.warnings,
      });
    } catch (err) {
      console.error(`[${batchId}] LOAD ERROR for "${fileName}": ${(err as Error).message}`);
      outcomes.push({ file: fileName, groupNameFromFile, status: "load_error", error: (err as Error).message });
    }
  }

  const finishedAt = new Date();
  const summary = {
    batchId,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dryRun: config.dryRun,
    filesTotal: files.length,
    filesLoaded: outcomes.filter((o) => o.status === "loaded").length,
    filesFailed: outcomes.filter((o) => o.status !== "loaded").length,
    totalRowsLoaded: outcomes.reduce((sum, o) => sum + (o.rowsLoaded ?? 0), 0),
    totalEmployeesUpserted: outcomes.reduce((sum, o) => sum + (o.employeesUpserted ?? 0), 0),
    outcomes,
  };

  const summaryPath = path.join(config.logDir, `run-${batchId}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[${batchId}] Summary written to ${summaryPath}`);
  console.log(`[${batchId}] Done: ${summary.filesLoaded}/${summary.filesTotal} files loaded, ${summary.totalRowsLoaded} rows / ${summary.totalEmployeesUpserted} employees total, ${summary.filesFailed} failure(s).`);

  return summary;
}

// CLI entry point - only runs when this file is executed directly (e.g.
// `node src/etl/loadElections.ts`, same as manual testing today). This
// guard matters: runLoadElections() is now ALSO imported and called by
// index.ts's in-process scheduler, and prisma.$disconnect() below must
// NEVER fire on that path - it would tear down the shared Prisma client
// the whole API server depends on, breaking every route until the next
// restart. pathToFileURL handles Windows path-separator/encoding
// differences correctly, unlike a plain string comparison would.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runLoadElections()
    .then((summary) => {
      if (summary && summary.filesFailed > 0) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error("FATAL:", err);
      process.exitCode = 2;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}