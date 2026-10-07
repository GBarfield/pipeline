// Destination: apps/api/src/routes/benefitsDocuments.ts
// Company-agnostic Benefits Administration document ingestion - mirrors
// commissionStatements.ts's v2 shape exactly (upload not gated behind
// picking a Group first; company resolved per row via a companyName
// column when present, else the filename, else left unassigned for
// manual tagging). Division-stamped from day one, unlike
// CommissionStatementEntry - see the schema comment in schema.prisma.
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';
import { resolveProductId } from '../lib/productMatch.ts';
import { ensureCarrierExists } from '../lib/carrierMatch.ts';
import { buildGroupIndex, matchGroup, deriveGroupNameFromFilename, type GroupIndex } from '../etl/groupMatch.ts';
import { hashSsn } from '../etl/piiHash.ts';
import { config } from '../etl/config.ts';

const router = Router();

router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const BUCKET_URL = process.env.BUCKET_URL || 'http://127.0.0.1:5001';

// --- Company resolution ------------------------------------------------
// Identical approach to commissionStatements.ts's resolveCompanyForRow.
async function resolveCompanyForRow(
  row: any,
  filenameFallback: string,
  index: GroupIndex
): Promise<{ groupId: number | null; companyNameRaw: string | null }> {
  const candidate = row.companyName || filenameFallback;
  if (!candidate) return { groupId: null, companyNameRaw: null };

  const result = matchGroup(index, candidate);
  if (result.status === 'matched') {
    return { groupId: result.groupId, companyNameRaw: candidate };
  }
  return { groupId: null, companyNameRaw: candidate };
}

const CARRIER_FILENAME_NOISE = /\.(csv|xlsx|xls|pdf)$/i;
const REPORT_TYPE_WORDS = /\b(reconciliation|census|roster|eligibility|enrollment|report)\b/gi;
const DATE_LIKE = /\b\d{1,4}[-_/]\d{1,2}[-_/]?\d{0,4}\b/g;

function deriveCarrierNameFromFilename(filename: string): string | null {
  const cleaned = filename
    .replace(CARRIER_FILENAME_NOISE, '')
    .replace(REPORT_TYPE_WORDS, '')
    .replace(DATE_LIKE, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

function hashEmployeeSsn(rawSsn: string | null | undefined): string | null {
  if (!rawSsn || !config.ssnPepper) return null;
  const hashed = hashSsn(rawSsn, config.ssnPepper);
  return hashed?.hash ?? null;
}

function parseCurrency(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n.toFixed(2);
}

// --- Upload --------------------------------------------------------------

// POST /api/benefits-documents/upload
router.post('/upload', requireRole('SUPER_USER'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Picked up front on the Reconciliation page's Group/Carrier selectors -
  // when present, these override the per-row/filename guessing in
  // persistBenefitsDocumentRows entirely. multer puts non-file multipart
  // fields on req.body as strings.
  const groupId = req.body.groupId ? Number(req.body.groupId) : null;
  const carrierName = req.body.carrierName ? String(req.body.carrierName) : null;

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('upload_kind', 'benefits_document');

    const bucketRes = await fetch(`${BUCKET_URL}/extract-tabular`, { method: 'POST', body: formData });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to process the file' });
    }

    if (bucketJson.needs_review) {
      return res.json({
        needsReview: true,
        mapping: bucketJson.mapping,
        mappingSource: bucketJson.mapping_source,
        preview: bucketJson.rows.slice(0, 5),
      });
    }

    const result = await persistBenefitsDocumentRows(req.file.originalname, bucketJson.rows, groupId, carrierName);
    res.status(201).json({ needsReview: false, ...result });
  } catch (err) {
    console.error('Failed to process benefits document upload:', err);
    res.status(500).json({ error: 'Failed to process benefits document upload' });
  }
});

// POST /api/benefits-documents/upload/confirm
router.post('/upload/confirm', requireRole('SUPER_USER'), upload.single('file'), async (req: Request, res: Response) => {
  const { mapping } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!mapping) {
    return res.status(400).json({ error: 'mapping is required' });
  }

  const groupId = req.body.groupId ? Number(req.body.groupId) : null;
  const carrierName = req.body.carrierName ? String(req.body.carrierName) : null;

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('upload_kind', 'benefits_document');
    formData.append('mapping', mapping);

    const bucketRes = await fetch(`${BUCKET_URL}/extract-tabular/confirm`, { method: 'POST', body: formData });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to process the file' });
    }

    const result = await persistBenefitsDocumentRows(req.file.originalname, bucketJson.rows, groupId, carrierName);
    res.status(201).json({ needsReview: false, ...result });
  } catch (err) {
    console.error('Failed to confirm benefits document mapping:', err);
    res.status(500).json({ error: 'Failed to confirm benefits document mapping' });
  }
});

async function persistBenefitsDocumentRows(
  sourceFile: string,
  rows: any[],
  overrideGroupId?: number | null,
  overrideCarrierName?: string | null
) {
  // Hardcoded-by-route division stamping, same pattern as deals.ts
  // (MARKETING) and commissionPeriods.ts (ACCOUNTING) - this route only
  // ever creates Benefits Administration records.
  const division = await prisma.division.findUniqueOrThrow({ where: { key: 'BENEFITS_ADMINISTRATION' } });

  // Re-uploading the same file REPLACES its prior rows rather than piling
  // up duplicates alongside them - same "delete stale rows for this
  // source, then re-insert" pattern already used by the nightly EN ->
  // CensusEntry sync (commission-census-sync-design.md S5). Scoped by
  // groupId too when one is picked, so re-uploading the same filename for
  // a DIFFERENT group never wipes the other group's data.
  //
  // CORRECTION: BenefitsDocumentUpload has no groupId column in the live
  // schema - confirmed via a live PrismaClientValidationError
  // ("Unknown argument groupId") when an earlier version of this fix tried
  // to filter Upload by it directly. Only BenefitsDocumentEntry carries
  // groupId, so staleness is scoped there, then any Upload header rows
  // left with zero entries afterward are swept up separately.
  await prisma.benefitsDocumentEntry.deleteMany({
    where: { sourceFile, divisionId: division.id, groupId: overrideGroupId ?? undefined },
  });
  await prisma.benefitsDocumentUpload.deleteMany({
    where: { sourceFile, divisionId: division.id, entries: { none: {} } },
  });

  // When a group was picked up front on the Reconciliation page, use it
  // directly instead of guessing from a companyName column or the
  // filename - this is what actually kills the "unassigned" queue for
  // uploads made this way. (companyNameRaw lives on the Entry, not the
  // Upload - see correction above.)
  let pickedGroupCompanyNameRaw: string | null = null;
  if (overrideGroupId) {
    const pickedGroup = await prisma.group.findUnique({ where: { id: overrideGroupId }, select: { company: true } });
    pickedGroupCompanyNameRaw = pickedGroup?.company ?? null;
  }

  const upload_ = await prisma.benefitsDocumentUpload.create({
    data: { sourceFile, divisionId: division.id, status: 'processed' },
  });

  const groupIndex = await buildGroupIndex(prisma);
  const filenameFallback = deriveGroupNameFromFilename(sourceFile);
  const carrierFilenameFallback = deriveCarrierNameFromFilename(sourceFile);

  const created = [];
  const skipped: { row: any; reason: string }[] = [];

  for (const row of rows) {
    // Same reasoning for carrier as for group: picking one up front on the
    // Reconciliation page is strictly more reliable than parsing it out of
    // a filename, so it wins when set.
    const carrierName = overrideCarrierName || row.carrierName || carrierFilenameFallback;
    const carrierNameConfirmed = !!overrideCarrierName || !!row.carrierName;
    if (!carrierName) {
      skipped.push({ row, reason: 'Missing carrier name (no column, and filename gave nothing usable)' });
      continue;
    }

    const productId = await resolveProductId(row.productLabel);
    await ensureCarrierExists(carrierName);

    const { groupId, companyNameRaw } = overrideGroupId
      ? { groupId: overrideGroupId, companyNameRaw: pickedGroupCompanyNameRaw }
      : await resolveCompanyForRow(row, filenameFallback, groupIndex);

    const employeeSsnHash = hashEmployeeSsn(row.employeeSsnRaw);
    let employeeId: number | null = null;
    if (groupId && employeeSsnHash) {
      const employee = await prisma.employee.findUnique({
        where: { groupId_employeeSsnHash: { groupId, employeeSsnHash } },
        select: { id: true },
      });
      employeeId = employee?.id ?? null;
    }

    const entry = await prisma.benefitsDocumentEntry.create({
      data: {
        uploadId: upload_.id,
        divisionId: division.id,
        groupId,
        companyNameRaw,
        sourceFile,
        employeeName: row.employeeName ?? null,
        employeeId,
        employeeSsnHash,
        carrierName,
        carrierNameConfirmed,
        productId,
        productLabel: row.productLabel ?? null,
        planName: row.planName ?? null,
        coverageTier: row.coverageTier ?? null,
        effectiveDate: row.effectiveDate ? new Date(row.effectiveDate) : null,
        terminationDate: row.terminationDate ? new Date(row.terminationDate) : null,
        status: row.status ?? null,
        employeeMonthlyCost: parseCurrency(row.employeeMonthlyCost),
        employeePerPayCost: parseCurrency(row.employeePerPayCost),
        employerMonthlyCost: parseCurrency(row.employerMonthlyCost),
        benefitAmount: parseCurrency(row.benefitAmount),
        coveredPayrollAmount: parseCurrency(row.coveredPayrollAmount),
        rawRow: row.rawRow,
      },
      include: { product: true, group: true },
    });
    created.push(entry);
  }

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} benefits document row(s) during import:`, skipped);
  }

  const unassignedCount = created.filter((e) => e.groupId === null).length;
  return { uploadId: upload_.id, entries: created, unassignedCount };
}

// --- Listing / unassigned queue --------------------------------------------

// GET /api/benefits-documents?groupId=&carrierName=&unassigned=true
router.get('/', async (req: Request, res: Response) => {
  const { groupId, carrierName, unassigned } = req.query;
  const restrictedDivisionId = req.user!.restrictedDivisionId;

  const where: any = {};
  if (unassigned === 'true') {
    where.groupId = null;
  } else if (groupId) {
    where.groupId = Number(groupId);
  }
  if (carrierName) {
    where.carrierName = { contains: String(carrierName), mode: 'insensitive' };
  }

  // Mirrors canAccessBenefitsDocumentEntry's reasoning: a BROKER_USER
  // never sees unassigned rows or another broker's rows. The division
  // filter is independent - this table only ever holds Benefits
  // Administration rows, so a user restricted to a different division
  // simply gets nothing back.
  if (req.user!.role !== 'SUPER_USER') {
    if (unassigned === 'true') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    where.group = { brokerId: req.user!.brokerId };
  }
  if (restrictedDivisionId !== null) {
    where.divisionId = restrictedDivisionId;
  }

  try {
    const entries = await prisma.benefitsDocumentEntry.findMany({
      where,
      include: { product: true, group: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(entries);
  } catch (err) {
    console.error('Failed to list benefits document entries:', err);
    res.status(500).json({ error: 'Failed to list benefits document entries' });
  }
});

// --- Assign an unassigned row to a Group ------------------------------------

// POST /api/benefits-documents/:id/assign-group
// Body: { groupId }. One-time manual tagging, identical pattern to
// commissionStatements.ts's assign-group route.
router.post('/:id/assign-group', requireRole('SUPER_USER'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { groupId } = req.body as { groupId?: number };

  if (!groupId) {
    return res.status(400).json({ error: 'groupId is required' });
  }
  if (!(await canAccessGroup(req.user!, groupId, res))) return;

  try {
    const entry = await prisma.benefitsDocumentEntry.update({
      where: { id },
      data: { groupId },
      include: { product: true, group: true },
    });
    res.json(entry);
  } catch (err) {
    console.error('Failed to assign benefits document entry to group:', err);
    res.status(500).json({ error: 'Failed to assign benefits document entry to group' });
  }
});

export default router;