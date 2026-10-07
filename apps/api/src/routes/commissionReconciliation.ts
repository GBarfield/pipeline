// Destination: apps/api/src/routes/commissionReconciliation.ts
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessCommissionPeriod } from '../lib/scope.ts';
import { resolveProductId, parseCurrency } from '../lib/productMatch.ts';
import { ensureCarrierExists } from '../lib/carrierMatch.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const periodId = Number(req.params.periodId);
  if (!(await canAccessCommissionPeriod(req.user!, periodId, res))) return;
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const BUCKET_URL = process.env.BUCKET_URL || 'http://127.0.0.1:5001';

// --- Census -----------------------------------------------------------

// GET /api/commission-periods/:periodId/census
router.get('/census', async (req: Request, res: Response) => {
  const periodId = Number(req.params.periodId);
  try {
    const entries = await prisma.censusEntry.findMany({
      where: { periodId },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(entries);
  } catch (err) {
    console.error('Failed to list census entries:', err);
    res.status(500).json({ error: 'Failed to list census entries' });
  }
});

// POST /api/commission-periods/:periodId/census-upload
router.post('/census-upload', upload.single('file'), async (req: Request, res: Response) => {
  const periodId = Number(req.params.periodId);
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('upload_kind', 'census');

    const bucketRes = await fetch(`${BUCKET_URL}/extract-tabular`, { method: 'POST', body: formData });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to process the file' });
    }

    if (bucketJson.needs_review) {
      // Don't persist anything yet - the frontend shows the proposed
      // mapping for confirmation, then re-uploads the same file to
      // /census-upload/confirm with the corrected mapping.
      return res.json({
        needsReview: true,
        mapping: bucketJson.mapping,
        mappingSource: bucketJson.mapping_source,
        preview: bucketJson.rows.slice(0, 5),
      });
    }

    const entries = await persistCensusRows(periodId, bucketJson.rows);
    res.status(201).json({ needsReview: false, entries });
  } catch (err) {
    console.error('Failed to process census upload:', err);
    res.status(500).json({ error: 'Failed to process census upload' });
  }
});

// POST /api/commission-periods/:periodId/census-upload/confirm
router.post('/census-upload/confirm', upload.single('file'), async (req: Request, res: Response) => {
  const periodId = Number(req.params.periodId);
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
    formData.append('upload_kind', 'census');
    formData.append('mapping', mapping);

    const bucketRes = await fetch(`${BUCKET_URL}/extract-tabular/confirm`, { method: 'POST', body: formData });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to process the file' });
    }

    const entries = await persistCensusRows(periodId, bucketJson.rows);
    res.status(201).json({ needsReview: false, entries });
  } catch (err) {
    console.error('Failed to confirm census mapping:', err);
    res.status(500).json({ error: 'Failed to confirm census mapping' });
  }
});

async function persistCensusRows(periodId: number, rows: any[]) {
  const created = [];
  const skipped: { row: any; reason: string }[] = [];

  for (const row of rows) {
    const premium = parseCurrency(row.premium);
    if (premium === null) {
      skipped.push({ row, reason: 'Missing or unparseable premium' });
      continue;
    }
    if (!row.employeeName) {
      skipped.push({ row, reason: 'Missing employee name' });
      continue;
    }

    const productId = await resolveProductId(row.productLabel);
    await ensureCarrierExists(row.carrierName);

    const entry = await prisma.censusEntry.create({
      data: {
        periodId,
        sourceFile: row.sourceFile,
        employeeName: row.employeeName,
        carrierName: row.carrierName || 'Unknown',
        productId,
        productLabel: row.productLabel ?? null,
        planName: row.planName ?? null,
        coverageTier: row.coverageTier ?? null,
        premium,
        rawRow: row.rawRow,
      },
      include: { product: true },
    });
    created.push(entry);
  }

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} census row(s) during import:`, skipped);
  }

  return created;
}

// Commission statement routes (upload, listing) and reconciliation moved out
// of this file under the v2 filtering design - they're no longer scoped to a
// single CommissionPeriod. See apps/api/src/routes/commissionStatements.ts
// (company-agnostic upload/listing) and apps/api/src/routes/reconciliationFilters.ts
// (filter templates + /compare). This file now only handles the census side,
// which is still genuinely per-group-per-month.

export default router;