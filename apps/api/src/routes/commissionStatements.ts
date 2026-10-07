// Destination: apps/api/src/routes/commissionStatements.ts
// Company-agnostic commission statement ingestion under the v2 filtering
// design. Upload no longer requires picking a Group first - company is
// resolved per row (via a companyName column Bucket now extracts, when the
// file has one) or, failing that, per file via the same matcher the
// Elections Loader uses for EN account names. Rows that still can't be
// resolved land unassigned for manual tagging.
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';
import { resolveProductId, parseCurrency } from '../lib/productMatch.ts';
import { ensureCarrierExists } from '../lib/carrierMatch.ts';
import { buildGroupIndex, matchGroup, deriveGroupNameFromFilename, type GroupIndex } from '../etl/groupMatch.ts';

const router = Router();

router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const BUCKET_URL = process.env.BUCKET_URL || 'http://127.0.0.1:5001';

// --- Company resolution --------------------------------------------------

async function resolveCompanyForRow(
  row: any,
  filenameFallback: string,
  index: GroupIndex
): Promise<{ groupId: number | null; companyNameRaw: string | null }> {
    // Prefer a per-row company field, now that Bucket extracts one when the
  // file has a company/employer column (Step 9). Falls back to the
  // filename when the file doesn't have one, same as the Elections Loader.
  const candidate = row.companyName || filenameFallback;
  if (!candidate) return { groupId: null, companyNameRaw: null };

  const result = matchGroup(index, candidate);
  if (result.status === 'matched') {
    return { groupId: result.groupId, companyNameRaw: candidate };
  }
  // 'ambiguous' and 'unmatched' both land unassigned - an ambiguous match
  // is exactly the kind of thing that should NOT be silently guessed at
  // for commission data.
  return { groupId: null, companyNameRaw: candidate };
}

// --- Upload ----------------------------------------------------------------

// POST /api/commission-statements/upload
router.post('/upload', requireRole('SUPER_USER'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('upload_kind', 'commission_statement');

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

    const result = await persistStatementRows(req.file.originalname, bucketJson.rows);
    res.status(201).json({ needsReview: false, ...result });
  } catch (err) {
    console.error('Failed to process commission statement upload:', err);
    res.status(500).json({ error: 'Failed to process commission statement upload' });
  }
});

// POST /api/commission-statements/upload/confirm
router.post('/upload/confirm', requireRole('SUPER_USER'), upload.single('file'), async (req: Request, res: Response) => {
  const { mapping } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!mapping) {
    return res.status(400).json({ error: 'mapping is required' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('upload_kind', 'commission_statement');
    formData.append('mapping', mapping);

    const bucketRes = await fetch(`${BUCKET_URL}/extract-tabular/confirm`, { method: 'POST', body: formData });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to process the file' });
    }

    const result = await persistStatementRows(req.file.originalname, bucketJson.rows);
    res.status(201).json({ needsReview: false, ...result });
  } catch (err) {
    console.error('Failed to confirm commission statement mapping:', err);
    res.status(500).json({ error: 'Failed to confirm commission statement mapping' });
  }
});

async function persistStatementRows(sourceFile: string, rows: any[]) {
  const upload_ = await prisma.commissionStatementUpload.create({
    data: { sourceFile, status: 'processed' },
  });

  const groupIndex = await buildGroupIndex(prisma);
  const filenameFallback = deriveGroupNameFromFilename(sourceFile);

  const created = [];
  const skipped: { row: any; reason: string }[] = [];

  for (const row of rows) {
    const reportedPremium = parseCurrency(row.reportedPremium);
    if (reportedPremium === null) {
      skipped.push({ row, reason: 'Missing or unparseable reportedPremium' });
      continue;
    }
    if (!row.carrierName) {
      skipped.push({ row, reason: 'Missing carrier name' });
      continue;
    }

    const productId = await resolveProductId(row.productLabel);
    await ensureCarrierExists(row.carrierName);
    const commissionAmount = parseCurrency(row.commissionAmount);
    const { groupId, companyNameRaw } = await resolveCompanyForRow(row, filenameFallback, groupIndex);

    const entry = await prisma.commissionStatementEntry.create({
      data: {
        uploadId: upload_.id,
        groupId,
        companyNameRaw,
        sourceFile,
        carrierName: row.carrierName,
        productId,
        productLabel: row.productLabel ?? null,
        statementPeriodStart: row.statementPeriodStart ? new Date(row.statementPeriodStart) : null,
        statementPeriodEnd: row.statementPeriodEnd ? new Date(row.statementPeriodEnd) : null,
        reportedPremium,
        commissionAmount,
        rawRow: row.rawRow,
      },
      include: { product: true, group: true },
    });
    created.push(entry);
  }

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} commission statement row(s) during import:`, skipped);
  }

  const unassignedCount = created.filter((e) => e.groupId === null).length;
  return { uploadId: upload_.id, entries: created, unassignedCount };
}

// --- Listing / unassigned queue --------------------------------------------

// GET /api/commission-statements?groupId=&carrierName=&unassigned=true
router.get('/', async (req: Request, res: Response) => {
  const { groupId, carrierName, unassigned } = req.query;

  const where: any = {};
  if (unassigned === 'true') {
    where.groupId = null;
  } else if (groupId) {
    where.groupId = Number(groupId);
  }
  if (carrierName) {
    where.carrierName = { contains: String(carrierName), mode: 'insensitive' };
  }

  // BROKER_USER never sees unassigned rows or another broker's rows - see
  // canAccessCommissionStatementEntry's reasoning in scope.ts.
  if (req.user!.role !== 'SUPER_USER') {
    if (unassigned === 'true') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    where.group = { brokerId: req.user!.brokerId };
  }

  try {
    const entries = await prisma.commissionStatementEntry.findMany({
      where,
      include: { product: true, group: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(entries);
  } catch (err) {
    console.error('Failed to list commission statement entries:', err);
    res.status(500).json({ error: 'Failed to list commission statement entries' });
  }
});

// --- Assign an unassigned row to a Group ------------------------------------

// POST /api/commission-statements/:id/assign-group
// Body: { groupId }. One-time manual tagging for rows that couldn't be
// auto-matched - mirrors the Elections Loader's one-time catch-up philosophy,
// just done through the UI instead of a script.
router.post('/:id/assign-group', requireRole('SUPER_USER'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { groupId } = req.body as { groupId?: number };

  if (!groupId) {
    return res.status(400).json({ error: 'groupId is required' });
  }
  if (!(await canAccessGroup(req.user!, groupId, res))) return;

  try {
    const entry = await prisma.commissionStatementEntry.update({
      where: { id },
      data: { groupId },
      include: { product: true, group: true },
    });
    res.json(entry);
  } catch (err) {
    console.error('Failed to assign commission statement entry to group:', err);
    res.status(500).json({ error: 'Failed to assign commission statement entry to group' });
  }
});

export default router;