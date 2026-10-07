// Destination: apps/api/src/etl/seed-missing-carriers.ts
//
// One-time catch-up, same shape/spirit as seed-missing-groups.ts: the
// Carrier catalog (schema.prisma's Carrier model - contactFirstName,
// address, logoImage, etc., used by the Marketing/quoting side) was never
// populated from the real carrier names that actually show up in
// Accounting's own data (EN elections, and any commission statements
// already uploaded). That's why GET /api/carriers has been correctly
// returning [] - there really are zero rows, not a bug in the query.
//
// This only backfills Carrier.name so these carriers become selectable in
// the Compare screen's typeahead. It does NOT attempt to fill in contact
// info (address/phone/logo/etc.) - nothing in Accounting's data has that
// anyway. A Super User can flesh a carrier's contact details out manually
// afterward via the Carriers admin screen if/when needed.
//
// Safe to re-run: checks existing Carrier.name (case-insensitive) before
// creating anything new. Carrier.name has NO unique constraint in the
// schema (unlike Product.name), so this script's own existing-check is
// the only thing standing between running it twice and getting duplicate
// rows - don't skip that check if you ever adapt this.
import { prisma } from '../lib/prisma.ts';

async function main() {
  const [electionCarriers, censusCarriers, statementCarriers] = await Promise.all([
    prisma.election.findMany({ distinct: ['carrier'], select: { carrier: true } }),
    prisma.censusEntry.findMany({ distinct: ['carrierName'], select: { carrierName: true } }),
    prisma.commissionStatementEntry.findMany({ distinct: ['carrierName'], select: { carrierName: true } }),
  ]);

  const rawNames = [
    ...electionCarriers.map((e) => e.carrier),
    ...censusCarriers.map((c) => c.carrierName),
    ...statementCarriers.map((s) => s.carrierName),
  ]
    .filter((name): name is string => !!name && name.trim().length > 0 && name.trim().toLowerCase() !== 'unknown')
    .map((name) => name.trim());

  const distinctRawNames = Array.from(new Set(rawNames));

  const existing = await prisma.carrier.findMany({ select: { name: true } });
  const existingLower = new Set(existing.map((c) => c.name.trim().toLowerCase()));

  // Case-insensitive dedupe against what's already in Carrier AND within
  // this batch itself - e.g. "Aetna" from an Election row and "AETNA"
  // from a statement row would otherwise both get created as separate
  // rows in the same run.
  const seenThisRun = new Set<string>();
  const toCreate: string[] = [];
  for (const name of distinctRawNames) {
    const key = name.toLowerCase();
    if (existingLower.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    toCreate.push(name);
  }

  console.log(
    `[seed-missing-carriers] ${distinctRawNames.length} distinct raw carrier name(s) found across ` +
    `Election/CensusEntry/CommissionStatementEntry`
  );
  console.log(`[seed-missing-carriers] ${existing.length} already in the Carrier catalog, ${toCreate.length} new to create`);

  if (toCreate.length === 0) {
    console.log('[seed-missing-carriers] Nothing to do.');
    return;
  }

  await prisma.carrier.createMany({ data: toCreate.map((name) => ({ name })) });

  console.log(`[seed-missing-carriers] Created: ${toCreate.join(', ')}`);
  console.log(
    '[seed-missing-carriers] NOTE: this pass only dedupes on exact-match-ignoring-case. It will NOT catch ' +
    'real-world variants like "Aetna" vs "Aetna Life Insurance Co." the way groupMatch.ts\'s normalizeGroupName ' +
    'does for company names - there is no equivalent carrier-name normalizer in this codebase yet. Worth a ' +
    'manual look at the created list above for near-duplicates before trusting this catalog is fully clean, ' +
    'the same caveat already flagged for Group.company having no unique constraint.'
  );
}

main()
  .catch((err) => {
    console.error('[seed-missing-carriers] Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });