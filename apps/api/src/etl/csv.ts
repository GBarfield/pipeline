import fs from "fs";
import { parse } from "csv-parse/sync";
import { hashSsn } from "./piiHash.ts";
import { config } from "./config.ts";

// --- Election columns (verified against 11 real group exports) -----------
const ELECTION_HEADER_MAP: Record<string, string> = {
  "enrollment type": "enrollmentType",
  "plan": "plan",
  "carrier": "carrier",
  "benefit": "benefit",
  "coverage level": "coverageLevel",
  "start date": "startDate",
  "start reason": "startReason",
  "end date": "endDate",
  "end reason": "endReason",
  "decline reason": "declineReason",
  "total monthly ee cost": "totalMonthlyEeCost",
  "total monthly plan cost": "totalMonthlyPlanCost",
  "ee monthly cost": "eeMonthlyCost",
  "er monthly cost": "erMonthlyCost",
  "plan monthly cost": "planMonthlyCost",
  "benefit amount": "benefitAmount",
  "covered payroll amount": "coveredPayrollAmount",
  "ee per pay cost": "eePerPayCost",
  "er per pay cost": "erPerPayCost",
  "eligible date": "eligibleDate",
  "enrolled on": "enrolledOn",
  "ended on": "endedOn",
  "last updated by": "lastUpdatedBy",
  "last updated date": "lastUpdatedDate",
  "pcp name": "pcpName",
  "pcp id": "pcpId",
  "pcp type": "pcpType",
  "base er cost": "baseErCost",
  "pcp current patient": "pcpCurrentPatient",
  "benefit allowance": "benefitAllowance",
  "pending ee cost": "pendingEeCost",
  "pending benefit amount": "pendingBenefitAmount",
  "pending covered payroll amount": "pendingCoveredPayrollAmount",
  "plan policy number": "planPolicyNumber",
  "carrier tobacco override": "carrierTobaccoOverride",
  "enrolled by": "enrolledBy",
};

const ELECTION_MONEY_FIELDS = new Set([
  "totalMonthlyEeCost", "totalMonthlyPlanCost", "eeMonthlyCost", "erMonthlyCost",
  "planMonthlyCost", "benefitAmount", "coveredPayrollAmount", "eePerPayCost",
  "erPerPayCost", "baseErCost", "benefitAllowance", "pendingEeCost",
  "pendingBenefitAmount", "pendingCoveredPayrollAmount",
]);

const ELECTION_DATE_FIELDS = new Set([
  "startDate", "endDate", "eligibleDate", "enrolledOn", "endedOn", "lastUpdatedDate",
]);

// --- Employee/demographic columns (added to the real export 2026-08) -----
// SSN is handled separately below (hashed), not through this map.
const EMPLOYEE_HEADER_MAP: Record<string, string> = {
  "first name": "firstName",
  "middle name": "middleName",
  "last name": "lastName",
  "suffix": "suffix",
  "preferred name": "preferredName",
  "display name": "displayName",
  "full name": "fullName",
  "sex": "sex",
  "gender identity": "genderIdentity",
  "dob": "dob",
  "age": "age",
  "marital status": "maritalStatus",
  "date of marriage": "dateOfMarriage",
  "u.s. citizen": "usCitizen",
  "visa status": "visaStatus",
  "veteran status": "veteranStatus",
  "military reserve status": "militaryReserveStatus",
  "race/ethnicity": "raceEthnicity",
  "language": "language",
  "driver's license number": "driversLicenseNumber",
  "office": "office",
  "class": "class",
  "payroll group": "payrollGroup",
  "division": "division",
  "department": "department",
  "business unit": "businessUnit",
  "benefit work state": "benefitWorkState",
  "payroll work state": "payrollWorkState",
  "cost center": "costCenter",
  "is collectively bargained": "isCollectivelyBargained",
  "job title": "jobTitle",
  "job classification": "jobClassification",
  "manager": "manager",
  "manager email": "managerEmail",
  "demographic change effective date": "demographicChangeEffectiveDate",
};

const EMPLOYEE_DATE_FIELDS = new Set(["dob", "dateOfMarriage", "demographicChangeEffectiveDate"]);
const EMPLOYEE_INT_FIELDS = new Set(["age"]);
const SSN_HEADER = "Social Security Number";

export interface ParsedEmployee {
  employeeSsnHash: string;
  employeeSsnLast4: string | null;
  employeeSsnPlaintext: string | null;
  fields: Record<string, unknown>;
  rawRow: Record<string, string>;
}

export interface ParsedElectionRow {
  employeeSsnHash: string | null; // links to a ParsedEmployee, resolved to employeeId at load time
  fields: Record<string, unknown>;
  rawRow: Record<string, string>;
}

export interface ParseResult {
  employees: Map<string, ParsedEmployee>; // keyed by employeeSsnHash
  elections: ParsedElectionRow[];
  totalDataRows: number;
  skippedBlankRows: number;
  unmappedHeaders: string[];
  warnings: string[];
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseMoney(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1"); // (123.45) => -123.45
  const n = Number(cleaned);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

function parseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseInt10(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * A row is "real" if any of the core identifying election columns are
 * populated. Employee Navigator's older export format included fully-blank
 * separator rows (e.g. a row whose only content is "Operations" in the Last
 * Updated By / Enrolled By columns) -- those are export artifacts, not
 * elections, and are dropped. Not observed in the newer full-demographic
 * export format, but the check is cheap to keep either way.
 */
function isBlankElectionRow(row: Record<string, string>): boolean {
  const core = ["Enrollment Type", "Plan", "Carrier", "Benefit", "Coverage Level"];
  return core.every((k) => !(row[k] ?? "").trim());
}

function extractEmployee(record: Record<string, string>, warnings: string[]): ParsedEmployee | null {
  const rawSsn = (record[SSN_HEADER] ?? "").trim();
  if (!rawSsn) return null; // old-format file without an SSN column, or blank for this row

  if (!config.ssnPepper) {
    warnings.push("SSN column present but SSN_PEPPER is not set -- cannot hash; rows with an SSN will not resolve to an Employee.");
    return null;
  }
  const hashed = hashSsn(rawSsn, config.ssnPepper);
  if (!hashed) {
    warnings.push(`Value in Social Security Number column did not look like a 9-digit SSN: "${rawSsn}"`);
    return null;
  }

  const fields: Record<string, unknown> = {};
  for (const [rawHeader, value] of Object.entries(record)) {
    const norm = normalizeHeader(rawHeader);
    const mapped = EMPLOYEE_HEADER_MAP[norm];
    if (!mapped) continue;
    if (EMPLOYEE_DATE_FIELDS.has(mapped)) {
      fields[mapped] = parseDate(value ?? "");
    } else if (EMPLOYEE_INT_FIELDS.has(mapped)) {
      fields[mapped] = parseInt10(value ?? "");
    } else {
      const v = (value ?? "").trim();
      fields[mapped] = v === "" ? null : v;
    }
  }

  return {
    employeeSsnHash: hashed.hash,
    employeeSsnLast4: hashed.last4,
    employeeSsnPlaintext: config.storeSsnPlaintext ? rawSsn : null,
    fields,
    rawRow: record,
  };
}

export function parseElectionCsv(filePath: string): ParseResult {
  const raw = fs.readFileSync(filePath, "utf-8");
  const records: Record<string, string>[] = parse(raw, {
    columns: (headerRow: string[]) => headerRow.map((h) => h.trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  const warnings: string[] = [];
  const employees = new Map<string, ParsedEmployee>();
  const elections: ParsedElectionRow[] = [];
  let skippedBlankRows = 0;

  const sampleHeaders = records.length > 0 ? Object.keys(records[0]) : [];
  const unmappedHeaders: string[] = [];
  for (const h of sampleHeaders) {
    if (h === "" || h === SSN_HEADER) continue; // trailing-comma artifact / handled separately
    const norm = normalizeHeader(h);
    if (ELECTION_HEADER_MAP[norm] || EMPLOYEE_HEADER_MAP[norm]) continue;
    unmappedHeaders.push(h);
  }
  if (unmappedHeaders.length > 0) {
    warnings.push(
      `Unrecognized columns present (captured in rawRow only, not in typed fields): ${unmappedHeaders.join(", ")}`
    );
  }

  for (const record of records) {
    if (isBlankElectionRow(record)) {
      skippedBlankRows += 1;
      continue;
    }

    const employee = extractEmployee(record, warnings);
    if (employee && !employees.has(employee.employeeSsnHash)) {
      employees.set(employee.employeeSsnHash, employee);
    }

    const fields: Record<string, unknown> = {};
    for (const [rawHeader, value] of Object.entries(record)) {
      const norm = normalizeHeader(rawHeader);
      const mapped = ELECTION_HEADER_MAP[norm];
      if (!mapped) continue;
      if (ELECTION_MONEY_FIELDS.has(mapped)) {
        fields[mapped] = parseMoney(value ?? "");
      } else if (ELECTION_DATE_FIELDS.has(mapped)) {
        fields[mapped] = parseDate(value ?? "");
      } else {
        const v = (value ?? "").trim();
        fields[mapped] = v === "" ? null : v;
      }
    }

    elections.push({
      employeeSsnHash: employee?.employeeSsnHash ?? null,
      fields,
      rawRow: record,
    });
  }

  return {
    employees,
    elections,
    totalDataRows: records.length,
    skippedBlankRows,
    unmappedHeaders,
    warnings,
  };
}
