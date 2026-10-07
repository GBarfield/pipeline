// Destination: apps/api/src/etl/groupMatch.ts
//
// 2026-08-28 change: removed the Dice-similarity "possible_duplicate" fallback.
// It was scoring any two companies that share a first word (or generic
// industry suffix) as suspiciously similar once the score cleared the
// configured threshold - which is exactly what happened to "Teamsters LOCAL
// 1932 Union" (71% similar to the unrelated "Teamsters Local 63") and is
// happening every night to three separate, real "Berkshire ..." accounts.
// Those are permanently similar to each other by name, not just on a bad
// night, so the fuzzy check was never going to stop flagging them.
//
// New rule, per Gregg: match must be exact (or exact modulo case/punctuation/
// whitespace via normalizeGroupName - not a judgment call, just formatting
// noise). Anything else auto-creates a new group instead of being held for
// manual review. This trades away the old safety net that caught a company
// re-downloaded under a slightly different derived name (a real EN-side
// rename, or a stray formatting quirk normalization doesn't already cover)
// - that case now silently creates a second group instead of surfacing for
// review. The one variant of that we know actually happens - Windows
// appending " (1)", " (2)", etc. to a re-downloaded file - is closed off
// below by stripping that suffix before any comparison happens at all, so it
// no longer needs the fuzzy fallback to catch it.
import path from "path";
import type { PrismaClient } from "../../generated/prisma/client.ts";

export interface GroupRef {
  id: number;
  name: string;
}

export interface GroupIndex {
  byExactName: Map<string, GroupRef>;
  byNormalizedName: Map<string, GroupRef[]>;
}

export type MatchResult =
  | { status: "matched"; groupId: number; groupName: string; matchType: "exact" | "normalized" }
  | { status: "unmatched" }
  | { status: "ambiguous"; candidates: GroupRef[] };

export function deriveGroupNameFromFilename(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath)).trim();
  // Strip a trailing Windows duplicate-download suffix like " (1)", " (2)" -
  // without this, a company whose report gets re-downloaded (a retry, a
  // manual re-run) would derive a name that no longer exact-matches its own
  // existing group now that there's no fuzzy fallback to catch it, and would
  // silently spin up a duplicate group instead.
  return stem.replace(/\s*\(\d+\)$/, "").trim();
}

export function normalizeGroupName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bdba\b/g, "dba")
    .replace(/[.,'"()&_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function buildGroupIndex(prisma: PrismaClient): Promise<GroupIndex> {
  const groups = await prisma.group.findMany({ select: { id: true, company: true } });
  const byExactName = new Map<string, GroupRef>();
  const byNormalizedName = new Map<string, GroupRef[]>();
  for (const g of groups) {
    const ref: GroupRef = { id: g.id, name: g.company };
    byExactName.set(g.company, ref);
    const norm = normalizeGroupName(g.company);
    const list = byNormalizedName.get(norm) ?? [];
    list.push(ref);
    byNormalizedName.set(norm, list);
  }
  return { byExactName, byNormalizedName };
}

export function matchGroup(index: GroupIndex, filenameStem: string): MatchResult {
  const exact = index.byExactName.get(filenameStem);
  if (exact) return { status: "matched", groupId: exact.id, groupName: exact.name, matchType: "exact" };

  const norm = normalizeGroupName(filenameStem);
  const candidates = index.byNormalizedName.get(norm) ?? [];
  if (candidates.length === 1) {
    return { status: "matched", groupId: candidates[0].id, groupName: candidates[0].name, matchType: "normalized" };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", candidates };
  }
  return { status: "unmatched" };
}

export type AutoMatchResult =
  | { status: "matched"; groupId: number; groupName: string; matchType: "exact" | "normalized" | "auto_created" | "would_auto_create" }
  | { status: "ambiguous"; candidates: GroupRef[] }
  | { status: "possible_duplicate"; possibleDuplicateOf: { groupId: number; groupName: string }; similarityScore: number };

/**
 * Resolves a filename to a Group. A match must be exact, or exact once
 * case/punctuation/whitespace formatting is normalized away - nothing looser
 * than that. Anything that isn't one of those auto-creates a brand new
 * group rather than being held for manual review as a "possible duplicate."
 *
 * `opts.similarityThreshold` is accepted for backwards compatibility with
 * existing callers/config but is no longer used - see the file header for
 * why the fuzzy-similarity fallback was removed.
 */
export async function matchOrCreateGroup(
  index: GroupIndex,
  prisma: PrismaClient,
  filenameStem: string,
  opts: { dryRun: boolean; similarityThreshold: number }
): Promise<AutoMatchResult> {
  const direct = matchGroup(index, filenameStem);
  if (direct.status !== "unmatched") {
    return direct;
  }

  if (opts.dryRun) {
    const placeholder: GroupRef = { id: -1, name: filenameStem };
    index.byExactName.set(filenameStem, placeholder);
    const norm = normalizeGroupName(filenameStem);
    const list = index.byNormalizedName.get(norm) ?? [];
    list.push(placeholder);
    index.byNormalizedName.set(norm, list);
    return { status: "matched", groupId: -1, groupName: filenameStem, matchType: "would_auto_create" };
  }

  const created = await prisma.group.create({ data: { company: filenameStem }, select: { id: true, company: true } });
  const ref: GroupRef = { id: created.id, name: created.company };
  index.byExactName.set(created.company, ref);
  const norm = normalizeGroupName(created.company);
  const list = index.byNormalizedName.get(norm) ?? [];
  list.push(ref);
  index.byNormalizedName.set(norm, list);
  return { status: "matched", groupId: created.id, groupName: created.company, matchType: "auto_created" };
}