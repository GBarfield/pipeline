// Destination: apps/api/src/etl/importEnCarrierContacts.ts
//
// One-time (but safe to re-run) import of carrier contact emails scraped
// from Employee Navigator's help center, section "Partner Configurations:
// Broker Instructions"
// (https://support.employeenavigator.com/hc/en-us/sections/360000088606).
// Source data: src/etl/data/en_carrier_contacts.csv, scraped 2026-11-14.
//
// What it does:
//   1. Maps each EN article to one canonical PipeLine company name and a
//      partnerType (EN_CARRIERS below): CARRIER for insurance carriers, TPA
//      for TPAs/administrators, VENDOR for software/quoting vendors. TPA and
//      VENDOR rows live in the same Carrier table but only show on the
//      "TPAs & Vendors" page, never in carrier pickers (GET /api/carriers
//      defaults to CARRIER). The Fringe article is split into its individual
//      vendors (ARAG, LegalShield, ...), each its own CARRIER. Every company
//      on the EN "Cafeteria and COBRA TPA Partners" list becomes a TPA.
//   2. Finds the matching Carrier row: exact name match ignoring case, then
//      a normalized match (punctuation, "Insurance", "Company", "Inc"
//      dropped), then a word-prefix match. Every candidate list includes
//      known aliases ("UHC", "United Healthcare", ...). If nothing matches,
//      it creates a new Carrier with `name` and `partnerType` set. An
//      existing row's partnerType is never changed. If it differs from
//      what EN implies, the dry run flags it [TYPE DIFFERS] so it can be
//      fixed by hand on the Carriers or TPAs & Vendors page.
//   3. Adds CarrierContact rows (name, title, email, phone). One row per
//      (carrier, email). `title` holds the request types the address
//      handles, which is how the Carriers screen and RFQ contact dropdown
//      tell contacts apart. Carrier's own single-contact columns are left
//      alone.
//
// Re-run safety: a contact is skipped if that carrier already has a
// CarrierContact with the same email (ignoring case), active or not.
// Deactivated rows stay deactivated and hand-edited rows are not
// overwritten.
//
// Usage (from apps/api):
//   node src/etl/importEnCarrierContacts.ts            # dry run, prints the plan, writes nothing
//   node src/etl/importEnCarrierContacts.ts --apply    # writes everything in one transaction
//   optional: --file <path-to-csv>
//   optional: --only CARRIER|TPA|VENDOR (comma list) to import just those types
//
// Requires the 20261114200000_add_carrier_partner_type migration.
//
// Always read the dry-run output first, especially rows marked
// [PREFIX MATCH], because those are the guesses. Fix a wrong one by adding
// an alias to EN_CARRIERS or renaming the Carrier row, then run again.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- EN article title -> canonical carrier (+ extra match aliases) ---------
// An article missing from this map is reported and skipped. `type`
// defaults to CARRIER.
type PartnerTypeName = 'CARRIER' | 'TPA' | 'VENDOR';
type Def = { name: string; aliases?: string[]; type?: PartnerTypeName };
type CarrierDef = Def;

const EN_CARRIERS: Record<string, CarrierDef> = {
  '5Star Life Insurance Company': { name: '5Star Life', aliases: ['5 Star Life', '5Star Life Insurance', 'Five Star Life'] },
  'Aetna (Small Midsize Business)': { name: 'Aetna', aliases: ['Aetna Life Insurance', 'Aetna Health'] },
  'Aflac': { name: 'Aflac', aliases: ['American Family Life Assurance'] },
  'AFR Life': { name: 'AFR Life', aliases: ['American Fidelity Assurance'] },
  'American Public Life Insurance Company (APL)': { name: 'American Public Life', aliases: ['APL', 'American Public Life Insurance'] },
  'Ameritas': { name: 'Ameritas', aliases: ['Ameritas Life'] },
  'Anthem BCBS: Small Group': { name: 'Anthem', aliases: ['Anthem BCBS', 'Anthem Blue Cross', 'Anthem Blue Cross Blue Shield', 'Anthem Blue Cross and Blue Shield'] },
  'Apex-MEC': { name: 'Apex-MEC', aliases: ['Apex MEC', 'Apex'] },
  'Assurity': { name: 'Assurity', aliases: ['Assurity Life'] },
  'Atlantic American': { name: 'Atlantic American', aliases: ['Bankers Fidelity'] },
  'BCS': { name: 'BCS', aliases: ['BCS Financial', 'BCS Insurance'] },
  'Beam Benefits': { name: 'Beam Benefits', aliases: ['Beam', 'Beam Dental'] },
  'BlueChoice HealthPlan of South Carolina': { name: 'BlueChoice HealthPlan of South Carolina', aliases: ['BlueChoice HealthPlan', 'BlueChoice SC'] },
  'BlueCross BlueShield of South Carolina': { name: 'BlueCross BlueShield of South Carolina', aliases: ['BCBS of South Carolina', 'BCBS SC', 'BlueCross BlueShield SC', 'Blue Cross Blue Shield of South Carolina'] },
  'Boston Mutual': { name: 'Boston Mutual', aliases: ['Boston Mutual Life'] },
  'Chubb/Combined Insurance': { name: 'Chubb', aliases: ['Combined Insurance', 'Chubb/Combined', 'Chubb Combined', 'Combined'] },
  'Colonial Life Product Hosting': { name: 'Colonial Life', aliases: ['Colonial', 'Colonial Life & Accident'] },
  'Community Eye Care': { name: 'Community Eye Care', aliases: ['CEC Vision', 'CEC'] },
  'Companion Life': { name: 'Companion Life', aliases: ['Companion Life Insurance'] },
  'Curative': { name: 'Curative' },
  'Cypress Dental': { name: 'Cypress Dental', aliases: ['Cypress Benefit Administrators'] },
  'Davis Vision': { name: 'Davis Vision' },
  'Dearborn Life Insurance Company': { name: 'Dearborn Life', aliases: ['Dearborn Group', 'Dearborn National', 'Dearborn'] },
  'Delta Dental of Arizona': { name: 'Delta Dental of Arizona', aliases: ['Delta Dental AZ'] },
  'Delta Dental of Colorado': { name: 'Delta Dental of Colorado', aliases: ['Delta Dental Colorado'] },
  'Delta Dental of Missouri and South Carolina': { name: 'Delta Dental of Missouri', aliases: ['Delta Dental of Missouri and South Carolina', 'Delta Dental MO', 'Delta Dental of South Carolina'] },
  'Delta Dental of Virginia': { name: 'Delta Dental of Virginia', aliases: ['Delta Dental VA'] },
  'Dental Select': { name: 'Dental Select' },
  'EMI Health': { name: 'EMI Health', aliases: ['EMI'] },
  'Equitable': { name: 'Equitable', aliases: ['AXA Equitable'] },
  'EyeMed': { name: 'EyeMed', aliases: ['EyeMed Vision Care'] },
  'Guardian': { name: 'Guardian', aliases: ['Guardian Life', 'The Guardian'] },
  'Health Plan of Nevada and Sierra Health and Life': { name: 'Health Plan of Nevada', aliases: ['HPN', 'Sierra Health and Life', 'Sierra Health & Life'] },
  'HealthJoy': { name: 'HealthJoy' },
  'HRI Dental & Vision': { name: 'HRI Dental & Vision', aliases: ['HRI', 'Insuring Smiles'] },
  'Humana': { name: 'Humana' },
  'Kaiser Permanente': { name: 'Kaiser Permanente', aliases: ['Kaiser'] },
  'Kansas City Life': { name: 'Kansas City Life', aliases: ['KC Life'] },
  'Lincoln Financial Group': { name: 'Lincoln Financial', aliases: ['Lincoln Financial Group', 'Lincoln National', 'Lincoln'] },
  'ManhattanLife': { name: 'ManhattanLife', aliases: ['Manhattan Life'] },
  'MassMutual': { name: 'MassMutual', aliases: ['Mass Mutual', 'Massachusetts Mutual'] },
  'Medical Mutual': { name: 'Medical Mutual', aliases: ['Medical Mutual of Ohio'] },
  'MetLife': { name: 'MetLife', aliases: ['Metropolitan Life', 'Met Life'] },
  'Michigan Manufacturers Association (MMA)': { name: 'Michigan Manufacturers Association' },
  'MotivHealth': { name: 'MotivHealth', aliases: ['Motiv Health'] },
  'Mutual of Omaha': { name: 'Mutual of Omaha' },
  'Nationwide (formerly Allstate Benefits: Group Health)': { name: 'Nationwide', aliases: ['Nationwide Group Health'] },
  'New York Life Insurance Company': { name: 'New York Life', aliases: ['NY Life'] },
  'Nippon Life Benefits': { name: 'Nippon Life Benefits', aliases: ['Nippon Life'] },
  'Northwest Dental Benefits': { name: 'Northwest Dental Benefits' },
  'OneAmerica': { name: 'OneAmerica', aliases: ['One America'] },
  'Optimyl Benefits': { name: 'Optimyl Benefits', aliases: ['Optimyl'] },
  'Pacific Life': { name: 'Pacific Life' },
  'PacificSource Health Plans': { name: 'PacificSource', aliases: ['PacificSource Health Plans', 'Pacific Source'] },
  'Principal': { name: 'Principal', aliases: ['Principal Financial', 'Principal Financial Group', 'Principal Life'] },
  'Prominence Health Plan': { name: 'Prominence Health Plan', aliases: ['Prominence'] },
  'Prudential': { name: 'Prudential' },
  'Recuro Health (formerly Competitive Health)': { name: 'Recuro Health', aliases: ['Recuro', 'Competitive Health'] },
  'Redirect Health': { name: 'Redirect Health' },
  'Reliance Matrix': { name: 'Reliance Matrix', aliases: ['Reliance Standard', 'Matrix Absence Management'] },
  'Renaissance Life & Health Insurance': { name: 'Renaissance', aliases: ['Renaissance Life & Health', 'Renaissance Dental'] },
  'Select Health': { name: 'Select Health', aliases: ['SelectHealth'] },
  'Sentara Health': { name: 'Sentara Health', aliases: ['Sentara', 'Sentara Health Plans', 'Optima Health'] },
  'Sidecar Health': { name: 'Sidecar Health', aliases: ['Sidecar'] },
  'Solstice': { name: 'Solstice', aliases: ['Solstice Benefits'] },
  'Sun Life': { name: 'Sun Life', aliases: ['Sun Life Financial', 'SunLife'] },
  'Superior Vision': { name: 'Superior Vision' },
  'Symetra': { name: 'Symetra', aliases: ['Symetra Life'] },
  'Texas Republic Life': { name: 'Texas Republic Life' },
  'The Hartford': { name: 'The Hartford', aliases: ['Hartford', 'Hartford Life'] },
  'The Standard': { name: 'The Standard', aliases: ['Standard Insurance', 'Standard Insurance Company'] },
  // Formerly Allstate Benefits Voluntary. Now part of The Standard, so its
  // contacts go under The Standard with sub-group "AHL (Voluntary)".
  'The Standard - AHL (formerly Allstate Benefits: Voluntary)': { name: 'The Standard', aliases: ['Standard Insurance', 'Standard Insurance Company'] },
  'Transamerica': { name: 'Transamerica' },
  'Trustmark - Group File': { name: 'Trustmark', aliases: ['Trustmark Voluntary'] },
  'United Concordia Dental': { name: 'United Concordia', aliases: ['United Concordia Dental', 'UCCI'] },
  'United Heritage': { name: 'United Heritage', aliases: ['United Heritage Life'] },
  'United Pet Care': { name: 'United Pet Care' },
  'UnitedHealthcare': { name: 'UnitedHealthcare', aliases: ['United Healthcare', 'UHC', 'United Health Care'] },
  'UnitedHealthcare- FACETS (Financial Protection plans)': { name: 'UnitedHealthcare', aliases: ['United Healthcare', 'UHC', 'United Health Care'] },
  'UnitedHealthcare-Prime Integration': { name: 'UnitedHealthcare', aliases: ['United Healthcare', 'UHC', 'United Health Care'] },
  'UNUM': { name: 'Unum', aliases: ['Unum Group', 'Unum Life'] },
  'USAble Life': { name: 'USAble Life', aliases: ['USAble'] },
  'Vision Benefits of America': { name: 'Vision Benefits of America', aliases: ['VBA'] },
  'Voya': { name: 'Voya', aliases: ['Voya Financial', 'ReliaStar'] },
  'VSP': { name: 'VSP', aliases: ['VSP Vision Care', 'Vision Service Plan'] },
  'Wishbone (formerly Pet Benefit Solutions)': { name: 'Wishbone', aliases: ['Pet Benefit Solutions', 'Wishbone Pet'] },
  'XP Health': { name: 'XP Health' },
  // Fringe is a bundle article. Each row's sub_group names the real
  // vendor, so the carrier comes from FRINGE_VENDORS instead.
  'Fringe (Legal, ID Protection, Telemed, Other)': { name: '__FRINGE__' },

  // TPAs / administrators / general agencies -> partnerType TPA.
  'AMWINS': { name: 'AMWINS', type: 'TPA', aliases: ['Amwins Group Benefits', 'AmWINS'] },
  'BBP Admin': { name: 'BBP Admin', type: 'TPA', aliases: ['BBP Administration'] },
  'CRC Benefits (formerly BenefitMall) (Mid-Atlantic)': { name: 'CRC Benefits', type: 'TPA', aliases: ['BenefitMall', 'CRC Benefits (formerly BenefitMall)'] },
  'HealthEquity': { name: 'HealthEquity', type: 'TPA', aliases: ['Health Equity', 'HQY'] },
  'HSA Bank': { name: 'HSA Bank', type: 'TPA' },
  'iSolved Benefit Services': { name: 'iSolved Benefit Services', type: 'TPA', aliases: ['iSolved'] },
  'Optum Financial': { name: 'Optum Financial', type: 'TPA', aliases: ['Optum Financial (not Optum Bank)'] },
  'WEX': { name: 'WEX', type: 'TPA', aliases: ['WEX Health', 'WEX Inc'] },

  // Software / quoting / agency-management vendors -> partnerType VENDOR.
  'AgencyBloc': { name: 'AgencyBloc', type: 'VENDOR' },
  'AgencyBloc:  Modernize your commission tracking strategy': { name: 'AgencyBloc', type: 'VENDOR' },
  'Applied Systems -Quoting Integration': { name: 'Applied Systems', type: 'VENDOR', aliases: ['Applied Benefits Designer'] },
  'BenefitPoint - Quoting Integration': { name: 'BenefitPoint (Vertafore)', type: 'VENDOR', aliases: ['BenefitPoint', 'Vertafore'] },
  'BenefitsGuide Agency Management Integration': { name: 'BenefitsGuide', type: 'VENDOR' },
  'Benefitter Quoting Integration': { name: 'Benefitter', type: 'VENDOR' },
  'Benelinx Quoting Integration': { name: 'Benelinx', type: 'VENDOR' },
  'DropQuote - Quote Integration': { name: 'DropQuote', type: 'VENDOR' },
  'NextAgency - Agency Management Integration': { name: 'NextAgency', type: 'VENDOR', aliases: ['Take44'] },
  'PerfectQuote Quoting Integration': { name: 'PerfectQuote', type: 'VENDOR' },
  'Plansight Quoting Integration': { name: 'Plansight', type: 'VENDOR' },
  'Zywave Quoting Integration': { name: 'Zywave', type: 'VENDOR' },
};

const FRINGE_VENDORS: Record<string, { name: string; aliases?: string[] }> = {
  'AirMedCare Network': { name: 'AirMedCare Network', aliases: ['AirMedCare', 'AMCN'] },
  'Allstate Identity Protection': { name: 'Allstate Identity Protection', aliases: ['AIP', 'InfoArmor'] },
  'AllyHealth': { name: 'AllyHealth', aliases: ['Ally Health'] },
  'ARAG': { name: 'ARAG', aliases: ['ARAG Legal', 'ARAG Legal Insurance'] },
  'Beyond Med': { name: 'Beyond Med', aliases: ['BeyondMed'] },
  'Bi - Teladoc': { name: 'Bi - Teladoc', aliases: ['Daisy Health'] },
  'Equipoint Partners': { name: 'Equipoint Partners', aliases: ['Equipoint'] },
  'First Stop Health': { name: 'First Stop Health' },
  'freshbenies': { name: 'freshbenies', aliases: ['fresh benies'] },
  'Genomic Life': { name: 'Genomic Life' },
  'IdentityForce': { name: 'IdentityForce', aliases: ['Identity Force'] },
  'IDIQ': { name: 'IDIQ' },
  'IDX': { name: 'IDX' },
  'LegalEASE': { name: 'LegalEASE', aliases: ['Legal Ease'] },
  'Legal Resources': { name: 'Legal Resources' },
  'LegalShield': { name: 'LegalShield', aliases: ['Legal Shield', 'Pre-Paid Legal'] },
  'NortonLifeLock': { name: 'NortonLifeLock', aliases: ['Norton LifeLock', 'LifeLock', 'Gen Digital'] },
  'MASA': { name: 'MASA', aliases: ['MASA Global', 'MASA MTS'] },
  'MedPlus (Tokio Marine HCC)': { name: 'MedPlus (Tokio Marine HCC)', aliases: ['MedPlus', 'Tokio Marine HCC'] },
  'New Benefits': { name: 'New Benefits' },
  'One to One Health': { name: 'One to One Health', aliases: ['121 Health'] },
  'SwiftMD': { name: 'SwiftMD', aliases: ['Swift MD'] },
  'U.S. Legal Services': { name: 'U.S. Legal Services', aliases: ['US Legal Services'] },
  'YIG Administration': { name: 'YIG Administration', aliases: ['YIG'] },
};

// One company from EN's "Cafeteria and COBRA TPA Partners" list (the CSV
// carrier_name). A "(formerly X)" note is dropped from the name and X
// becomes an alias, and "(not ...)" notes are dropped. Other parentheticals
// that tell companies apart, like "(MMA East)", are kept.
function tpaDef(raw: string): Def {
  const aliases: string[] = [raw];
  let name = raw.replace(/\(formerly ([^)]+)\)/gi, (_m, prev: string) => { aliases.push(prev.trim()); return ''; });
  name = name.replace(/\(not [^)]+\)/gi, '').replace(/\s{2,}/g, ' ').trim();
  return { name, aliases, type: 'TPA' };
}

// Extra sub-group text put in front of a contact's title, so contacts
// merged from several EN articles stay distinguishable.
const ARTICLE_SUBGROUP: Record<string, string> = {
  'The Standard - AHL (formerly Allstate Benefits: Voluntary)': 'AHL (Voluntary)',
  'UnitedHealthcare- FACETS (Financial Protection plans)': 'FACETS / Financial Protection',
  'UnitedHealthcare-Prime Integration': 'Prime',
};

// --- name normalization (same spirit as groupMatch.ts) --------------------
const DROP_TOKENS = new Set(['the', 'insurance', 'ins', 'company', 'co', 'inc', 'llc', 'corp', 'corporation', 'of', 'america']);
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !DROP_TOKENS.has(t))
    .join(' ');
}

type ExistingCarrier = { id: number; name: string; partnerType: PartnerTypeName };
type MatchKind = 'EXACT' | 'NORMALIZED' | 'PREFIX MATCH' | 'NEW';

function findCarrier(def: Def, existing: ExistingCarrier[]): { carrier?: ExistingCarrier; kind: MatchKind; others: ExistingCarrier[] } {
  const cands = [def.name, ...(def.aliases ?? [])];
  const lower = new Set(cands.map((c) => c.trim().toLowerCase()));
  const normed = new Set(cands.map(norm).filter(Boolean));

  const pick = (hits: ExistingCarrier[], kind: MatchKind) => {
    const sorted = [...hits].sort((a, b) => a.id - b.id);
    return { carrier: sorted[0], kind, others: sorted.slice(1) };
  };

  let hits = existing.filter((c) => lower.has(c.name.trim().toLowerCase()));
  if (hits.length) return pick(hits, 'EXACT');

  hits = existing.filter((c) => normed.has(norm(c.name)));
  if (hits.length) return pick(hits, 'NORMALIZED');

  // Word-prefix match, one direction only: the existing name is the longer
  // form of a candidate, e.g. existing "Kaiser Foundation Health Plan" vs
  // candidate "Kaiser". The reverse is not allowed, so "Delta Dental of
  // Arizona" can never attach to a generic "Delta Dental" row. Requires at
  // least 4 characters so short tokens like "BCS" or "IDX" can't match
  // unrelated names.
  hits = existing.filter((c) => {
    const e = norm(c.name);
    if (!e) return false;
    for (const n of normed) {
      if (n.length >= 4 && e.startsWith(n + ' ')) return true;
    }
    return false;
  });
  if (hits.length) return pick(hits, 'PREFIX MATCH');

  return { kind: 'NEW', others: [] };
}

// --- contact shaping -------------------------------------------------------
const PHONE_RE = /\(?\+?1?[\s.-]*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\)?/;

function roleLabel(types: string): string {
  const t = types.toLowerCase();
  const has = (...k: string[]) => k.some((x) => t.includes(x));
  if (has('tpa contact')) return 'TPA Support';
  if (has('status', 'error', 'edi', 'integration', 'discrepanc', 'file errors', 'connection')) return 'EDI / Integration Support';
  if (has('billing', 'accounting')) return 'Billing';
  if (has('renewal')) return 'Renewals';
  if (has('access to care', 'enrollment')) return 'Enrollment';
  if (has('api')) return 'API Support';
  if (has('eoi', 'underwriting')) return 'Underwriting / EOI';
  if (has('quote', 'rfp', 'proposal', 'new or renewal', 'sales')) return 'Sales / Quotes';
  if (has('member', 'claims')) return 'Member Services';
  return 'General Support';
}

type CsvRow = {
  carrier_name: string; partner_type: string; source_article_title: string; sub_group: string;
  contact_name: string; email: string; request_types: string; source_article_id: string; source_url: string;
};

type PlannedContact = { email: string; names: string[]; phone?: string; titles: string[] };
type PlannedCarrier = { def: Def; type: PartnerTypeName; contacts: Map<string, PlannedContact>; articles: Set<string> };

function buildPlan(rows: CsvRow[], only: Set<PartnerTypeName>) {
  const plan = new Map<string, PlannedCarrier>(); // key: canonical name, lowercased
  const unmapped = new Set<string>();
  const skippedByType = new Set<string>();

  for (const r of rows) {
    const article = r.source_article_title.trim();
    let def: Def;
    if (r.partner_type === 'TPA') {
      def = tpaDef(r.carrier_name.trim());
    } else {
      if (!(article in EN_CARRIERS)) { unmapped.add(article); continue; }
      def = EN_CARRIERS[article];
    }

    let subGroup = r.sub_group.trim();
    if (def.name === '__FRINGE__') {
      const v = FRINGE_VENDORS[subGroup];
      if (!v) { unmapped.add(`${article} > ${subGroup}`); continue; }
      def = v;
      subGroup = ''; // the vendor is the carrier now
    }
    const type: PartnerTypeName = def.type ?? 'CARRIER';
    if (!only.has(type)) { skippedByType.add(def.name); continue; }
    const extraSub = ARTICLE_SUBGROUP[article];
    if (extraSub) subGroup = subGroup ? `${extraSub} - ${subGroup}` : extraSub;

    const key = def.name.toLowerCase();
    if (!plan.has(key)) plan.set(key, { def, type, contacts: new Map(), articles: new Set() });
    const pc = plan.get(key)!;
    // Same company from two sources (e.g. the HealthEquity article and the
    // TPA list): merge the alias lists.
    if (pc.def !== def) pc.def = { ...pc.def, aliases: [...new Set([...(pc.def.aliases ?? []), ...(def.aliases ?? [])])] };
    pc.articles.add(article);

    const email = r.email.trim().toLowerCase();
    if (!email) continue;

    // Pull a phone number out of the label, e.g. "HRI call center" (none)
    // or "General Inquiries (1-800-786-5433)".
    let label = r.contact_name.trim();
    let phone: string | undefined;
    const pm = label.match(PHONE_RE);
    if (pm) {
      phone = pm[0].replace(/^[\s(]+|[\s)]+$/g, '');
      label = label.replace(pm[0], '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    }

    // TPA-list rows only say "TPA contact", so spell out what that means.
    const reqTypes = r.partner_type === 'TPA' ? 'Cafeteria / COBRA TPA contact' : r.request_types.trim();
    const title = [subGroup, reqTypes].filter(Boolean).join(': ');
    const c = pc.contacts.get(email) ?? { email, names: [], titles: [] };
    if (label && !c.names.includes(label)) c.names.push(label);
    if (title && !c.titles.includes(title)) c.titles.push(title);
    if (phone && !c.phone) c.phone = phone;
    pc.contacts.set(email, c);
  }
  return { plan, unmapped, skippedByType };
}

const REGION_LABEL = /^(cobra|cafeteria|all other (states|groups)|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i;

function finalContact(carrierName: string, c: PlannedContact) {
  const title = c.titles.join(' | ');
  // A bare region or line label (Dearborn's per-state inboxes, a TPA's
// "COBRA" / "Cafeteria" box) means little in an
  // RFQ dropdown on its own, so put the carrier name in front of it.
  const label = c.names[0];
  const name = !label
    ? `${carrierName} ${roleLabel(title)}`
    : REGION_LABEL.test(label) ? `${carrierName} - ${label}` : label;
  return { name, title: title || null, email: c.email, phone: c.phone ?? null };
}

// --- main --------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : path.join(__dirname, 'data', 'en_carrier_contacts.csv');
  const onlyIdx = args.indexOf('--only');
  const allTypes: PartnerTypeName[] = ['CARRIER', 'TPA', 'VENDOR'];
  const onlyList = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').toUpperCase().split(',').filter((t): t is PartnerTypeName => (allTypes as string[]).includes(t)) : allTypes;
  if (!onlyList.length) throw new Error('--only expects CARRIER, TPA and/or VENDOR');
  const only = new Set(onlyList);

  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true }) as CsvRow[];
  const { plan, unmapped, skippedByType } = buildPlan(rows, only);

  const existing = (await prisma.carrier.findMany({ select: { id: true, name: true, partnerType: true } })) as ExistingCarrier[];
  const existingContacts = await prisma.carrierContact.findMany({ select: { carrierId: true, email: true } });
  const haveContact = new Set(existingContacts.map((c) => `${c.carrierId}|${c.email.trim().toLowerCase()}`));

  console.log(`[en-contacts] ${apply ? 'APPLY' : 'DRY RUN'}, file: ${file}`);
  const byType = (t: PartnerTypeName) => [...plan.values()].filter((p) => p.type === t).length;
  console.log(`[en-contacts] Types: ${[...only].join(', ')}`);
  console.log(`[en-contacts] ${rows.length} CSV rows -> ${plan.size} companies (${byType('CARRIER')} carriers, ${byType('TPA')} TPAs, ${byType('VENDOR')} vendors); ${existing.length} rows already in the Carrier table\n`);

  type Work = { pc: PlannedCarrier; carrierId?: number; kind: MatchKind; matchedName?: string; toAdd: ReturnType<typeof finalContact>[]; skipped: number };
  const work: Work[] = [];
  const counts = { EXACT: 0, NORMALIZED: 0, 'PREFIX MATCH': 0, NEW: 0 } as Record<MatchKind, number>;
  let typeDiffers = 0;

  const typeOrder: Record<PartnerTypeName, number> = { CARRIER: 0, TPA: 1, VENDOR: 2 };
  for (const pc of [...plan.values()].sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.def.name.localeCompare(b.def.name))) {
    const m = findCarrier(pc.def, existing);
    counts[m.kind]++;
    const w: Work = { pc, carrierId: m.carrier?.id, kind: m.kind, matchedName: m.carrier?.name, toAdd: [], skipped: 0 };
    for (const c of pc.contacts.values()) {
      if (w.carrierId && haveContact.has(`${w.carrierId}|${c.email}`)) { w.skipped++; continue; }
      w.toAdd.push(finalContact(pc.def.name, c));
    }
    work.push(w);

    const head = m.kind === 'NEW'
      ? `[NEW ${pc.type}] "${pc.def.name}"`
      : `[${m.kind}] ${pc.type} "${pc.def.name}" -> Carrier #${m.carrier!.id} "${m.carrier!.name}"`;
    console.log(`${head}: +${w.toAdd.length} contact(s)${w.skipped ? `, ${w.skipped} already present` : ''}`);
    if (m.carrier && m.carrier.partnerType !== pc.type) {
      typeDiffers++;
      console.log(`    [TYPE DIFFERS] existing row is ${m.carrier.partnerType}, EN says ${pc.type}. Left as ${m.carrier.partnerType}; change it on the Carriers / TPAs & Vendors page if needed.`);
    }
    if (m.others.length) console.log(`    WARNING: also matches ${m.others.map((o) => `#${o.id} "${o.name}"`).join(', ')}. Possible duplicate carriers, using the lowest id.`);
    for (const c of w.toAdd) console.log(`    + ${c.name} <${c.email}>${c.phone ? ` ${c.phone}` : ''}${c.title ? `  [${c.title.length > 90 ? c.title.slice(0, 87) + '...' : c.title}]` : ''}`);
  }

  console.log(`\n[en-contacts] Carrier matches: ${counts.EXACT} exact, ${counts.NORMALIZED} normalized, ${counts['PREFIX MATCH']} prefix (review these), ${counts.NEW} new`);
  console.log(`[en-contacts] Contacts to add: ${work.reduce((n, w) => n + w.toAdd.length, 0)}, already present: ${work.reduce((n, w) => n + w.skipped, 0)}`);
  if (typeDiffers) console.log(`[en-contacts] ${typeDiffers} matched row(s) have a different type than EN implies (see [TYPE DIFFERS]).`);
  if (skippedByType.size) console.log(`[en-contacts] Skipped by --only: ${skippedByType.size} compan${skippedByType.size === 1 ? 'y' : 'ies'}`);
  if (unmapped.size) console.log(`[en-contacts] WARNING, not in EN_CARRIERS/FRINGE_VENDORS, skipped: ${[...unmapped].sort().join('; ')}`);

  if (!apply) {
    console.log('\n[en-contacts] Dry run only, nothing written. Re-run with --apply to write.');
    return;
  }

  let createdCarriers = 0;
  let createdContacts = 0;
  await prisma.$transaction(async (tx) => {
    for (const w of work) {
      let carrierId = w.carrierId;
      if (!carrierId) {
        const c = await tx.carrier.create({ data: { name: w.pc.def.name, partnerType: w.pc.type }, select: { id: true } });
        carrierId = c.id;
        createdCarriers++;
      }
      if (w.toAdd.length) {
        const res = await tx.carrierContact.createMany({ data: w.toAdd.map((c) => ({ ...c, carrierId: carrierId! })) });
        createdContacts += res.count;
      }
    }
  }, { timeout: 60_000 });

  console.log(`\n[en-contacts] Done: created ${createdCarriers} carrier(s) and ${createdContacts} contact(s).`);
}

main()
  .catch((err) => {
    console.error('[en-contacts] Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
