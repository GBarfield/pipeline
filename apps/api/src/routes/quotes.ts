// Destination: apps/api/src/routes/quotes.ts
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma.ts';
import { buildRateTemplateWorkbook, parseRateTemplateWorkbook, flattenRateTemplateResult } from '../lib/rateTemplate.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessDeal } from '../lib/scope.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const dealId = Number(req.params.dealId);
  if (!(await canAccessDeal(req.user!, dealId, res))) return;
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const BUCKET_URL = process.env.BUCKET_URL || 'http://127.0.0.1:5001';

// Where original uploaded PDFs are kept so agents can pull up the source
// document next to the generated comparison, and so a Rate Type
// correction can re-run extraction later without asking the user to
// re-upload the same file. Lives under this app's own folder, not the
// Bucket's - the Bucket's own uploads/ dir is documented as temporary.
const ORIGINALS_DIR = path.join(process.cwd(), 'uploads', 'originals');

async function ensureOriginalsDir() {
  await fs.mkdir(ORIGINALS_DIR, { recursive: true });
}

const VALID_SOURCES = ['current', 'proposal'] as const;
type QuoteSource = (typeof VALID_SOURCES)[number];

function isValidSource(value: unknown): value is QuoteSource {
  return typeof value === 'string' && (VALID_SOURCES as readonly string[]).includes(value);
}

// Maps the Bucket classifier's fixed product_label enum (DOCUMENT_TRIAGE_TOOL in
// claude_client.py) to the exact catalog Product name it corresponds to, so a newly
// extracted quote can be auto-assigned to the real Product at creation time instead
// of landing as "unassigned" every single time - this is what was causing the
// same benefit line to fragment across multiple tabs in the comparison workbook
// (e.g. a real "Dental" tab plus a separate "Dental (unassigned)" one) until a human
// manually corrected the Product column. A hardcoded list, not a fuzzy match -
// deliberately small and explicit, since both the classifier's vocabulary and a
// benefits catalog are realistically never more than a couple dozen entries, and a
// wrong auto-guess on real client data is worse than leaving it for a human to
// assign. "Other" and "Unclear" are intentionally left unmapped, and there's no
// dedicated "Voluntary Life" catalog entry today, so that one maps to the closest
// existing product per team decision.
const PRODUCT_LABEL_TO_CATALOG_NAME: Record<string, string> = {
  Medical: 'Medical',
  Dental: 'Dental',
  Vision: 'Vision',
  'Basic Life and AD&D': 'Basic Life',
  'Voluntary Life and AD&D': 'Group (Term) Life',
  STD: 'Short Term Disability',
  LTD: 'Long Term Disability',
  'Critical Illness': 'Critical Illness',
  'Hospital Indemnity': 'Hospital Indemnity',
  Accident: 'Accident',
};

// --- Async upload job tracking (single-product path) ------------------
//
// Extraction (especially a Sonnet "discovery" pass on a new carrier) can
// take long enough to exceed the IIS/undici timeout chain in front of
// this app if handled as one long request/response. Instead, upload
// starts a job on the Bucket and returns a job_id immediately; Node then
// polls the Bucket ITSELF in the background (not driven by the frontend's
// polling) so the Quote gets created as soon as extraction finishes, even
// if the browser tab that started it is closed. The frontend's own
// polling against /upload/status/:jobId is a cheap, read-only check
// against this in-memory record - it doesn't drive anything.
//
// In-memory, lost on API restart - same tradeoff already made on the
// Bucket side for its own job store. Acceptable at this app's scale.

interface PendingUpload {
  dealId: number;
  productId: number | null;
  productLabel?: string | null;
  source: QuoteSource;
  productType: string;
  fileBuffer: Buffer;
  originalFilename: string;
  status: 'processing' | 'done' | 'error';
  log?: string[];
  quote?: unknown;
  error?: string;
}

const pendingUploads = new Map<string, PendingUpload>();
const POLL_INTERVAL_MS = 3000;
const CLEANUP_DELAY_MS = 5 * 60 * 1000; // clear finished jobs even if never polled

async function pollBucketJob(jobId: string) {
  const pending = pendingUploads.get(jobId);
  if (!pending || pending.status !== 'processing') return;

  try {
    const bucketRes = await fetch(`${BUCKET_URL}/upload/status/${jobId}`);
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      pending.status = 'error';
      pending.error = bucketJson.error || 'Unknown job';
      setTimeout(() => pendingUploads.delete(jobId), CLEANUP_DELAY_MS);
      return;
    }

    pending.log = bucketJson.log;

    if (bucketJson.status === 'processing') {
      setTimeout(() => pollBucketJob(jobId), POLL_INTERVAL_MS);
      return;
    }

    if (bucketJson.status === 'error') {
      pending.status = 'error';
      pending.error = bucketJson.error;
      setTimeout(() => pendingUploads.delete(jobId), CLEANUP_DELAY_MS);
      return;
    }

    // status === 'done' - create the Quote now, independent of whether
    // anyone's still watching from the frontend.
    const result = bucketJson.result;

    await ensureOriginalsDir();
    const safeName = pending.originalFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storedFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const storedPath = path.join(ORIGINALS_DIR, storedFilename);
    await fs.writeFile(storedPath, pending.fileBuffer);

    const quote = await prisma.quote.create({
      data: {
        dealId: pending.dealId,
        productId: pending.productId,
        productLabel: pending.productLabel ?? null,
        source: pending.source,
        carrierName: result.carrier,
        productType: pending.productType,
        usedDiscovery: Boolean(result.used_discovery),
        rawData: result.data,
        warnings: result.warnings ?? null,
        xlsxPath: result.download_url ?? null,
        originalPdfPath: storedPath,
      },
      include: { product: true },
    });

    pending.status = 'done';
    pending.quote = quote;
    setTimeout(() => pendingUploads.delete(jobId), CLEANUP_DELAY_MS);
  } catch (err) {
    console.error(`Failed while polling upload job ${jobId}:`, err);
    pending.status = 'error';
    pending.error = 'Failed to check upload status';
    setTimeout(() => pendingUploads.delete(jobId), CLEANUP_DELAY_MS);
  }
}

// --- Async job tracking (multi-product classify+extract path) ---------
//
// One PDF in, N Quotes out (one per detected product), driven by the
// Bucket's /extract route. Mirrors pollBucketJob above - same
// independent-background-poll design, same reason (don't lose results
// if the tab closes) - but fans out into multiple prisma.quote.create
// calls instead of one, and tracks which products the classifier found
// but couldn't extract (no rates present, or an unsupported rate type)
// so the frontend can show those as informational rows without them
// ever becoming real Quotes.

interface PendingExtractJob {
  dealId: number;
  source: QuoteSource;
  fileBuffer: Buffer;
  originalFilename: string;
  status: 'processing' | 'done' | 'error';
  log?: string[];
  quotes?: unknown[];
  skipped?: { productLabel: string; rateType: string | null; reason: string }[];
  carrier?: string | null;
  error?: string;
}

const pendingExtractJobs = new Map<string, PendingExtractJob>();

async function pollBucketExtractJob(jobId: string) {
  const pending = pendingExtractJobs.get(jobId);
  if (!pending || pending.status !== 'processing') return;

  try {
    const bucketRes = await fetch(`${BUCKET_URL}/upload/status/${jobId}`);
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok) {
      pending.status = 'error';
      pending.error = bucketJson.error || 'Unknown job';
      setTimeout(() => pendingExtractJobs.delete(jobId), CLEANUP_DELAY_MS);
      return;
    }

    pending.log = bucketJson.log;

    if (bucketJson.status === 'processing') {
      setTimeout(() => pollBucketExtractJob(jobId), POLL_INTERVAL_MS);
      return;
    }

    if (bucketJson.status === 'error') {
      pending.status = 'error';
      pending.error = bucketJson.error;
      setTimeout(() => pendingExtractJobs.delete(jobId), CLEANUP_DELAY_MS);
      return;
    }

    const result = bucketJson.result;
    const products: any[] = result?.products ?? [];

    await ensureOriginalsDir();
    const safeName = pending.originalFilename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storedFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const storedPath = path.join(ORIGINALS_DIR, storedFilename);
    await fs.writeFile(storedPath, pending.fileBuffer);

    // Looked up once per job, not once per product - the catalog is small and static
    // enough within a single extraction that this is just one extra query, not N.
    const catalogProducts = await prisma.product.findMany();
    const catalogIdByName = new Map(catalogProducts.map((p) => [p.name.toLowerCase(), p.id]));

    const createdQuotes: unknown[] = [];
    const skipped: { productLabel: string; rateType: string | null; reason: string }[] = [];

    for (const product of products) {
      if (product.skipped) {
        skipped.push({
          productLabel: product.product_label,
          rateType: product.rate_type ?? null,
          reason: product.skip_reason ?? 'Skipped',
        });
        continue;
      }

      // Auto-assign to the matching catalog Product when the classifier's label maps
      // to one we're confident about (see PRODUCT_LABEL_TO_CATALOG_NAME) - falls back
      // to null (unassigned, same as before) for "Other"/"Unclear" or any label with
      // no confident mapping, leaving it for a human to assign via the grid.
      const catalogName = PRODUCT_LABEL_TO_CATALOG_NAME[product.product_label as string];
      const matchedProductId = catalogName ? catalogIdByName.get(catalogName.toLowerCase()) ?? null : null;

      const quote = await prisma.quote.create({
        data: {
          dealId: pending.dealId,
          productId: matchedProductId,
          productLabel: product.product_label ?? null,
          source: pending.source,
          carrierName: result.carrier,
          productType: product.rate_type,
          usedDiscovery: Boolean(product.used_discovery),
          rawData: product.data,
          warnings: product.warnings ?? null,
          xlsxPath: product.download_url ?? null,
          originalPdfPath: storedPath,
        },
        include: { product: true },
      });
      createdQuotes.push(quote);
    }

    pending.status = 'done';
    pending.quotes = createdQuotes;
    pending.skipped = skipped;
    pending.carrier = result?.carrier ?? null;
    setTimeout(() => pendingExtractJobs.delete(jobId), CLEANUP_DELAY_MS);
  } catch (err) {
    console.error(`Failed while polling extract job ${jobId}:`, err);
    pending.status = 'error';
    pending.error = 'Failed to check extraction status';
    setTimeout(() => pendingExtractJobs.delete(jobId), CLEANUP_DELAY_MS);
  }
}

// GET /api/deals/:dealId/quotes
// Excludes soft-excluded rows by default - pass ?includeExcluded=true to
// see everything (e.g. for a forensic/audit view).
router.get('/', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { source, includeExcluded } = req.query;

  // Explicit no-store: this list is re-fetched right after every save (see
  // loadQuotes() in QuoteBucketPanel.tsx) specifically to pick up what was just
  // written, so any caching anywhere in the chain — browser, or IIS/ARR sitting in
  // front of this app as a reverse proxy — showing even a few seconds of a stale
  // copy here reads as "my save didn't stick." Belt-and-suspenders with the same
  // `cache: 'no-store'` added on the frontend's fetch call.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const quotes = await prisma.quote.findMany({
      where: {
        dealId,
        ...(isValidSource(source) ? { source } : {}),
        ...(includeExcluded === 'true' ? {} : { excluded: false }),
      },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(quotes);
  } catch (err) {
    console.error('Failed to list quotes:', err);
    res.status(500).json({ error: 'Failed to list quotes' });
  }
});

// POST /api/deals/:dealId/quotes/upload/start
// The ORIGINAL single-product flow: caller pre-selects productId +
// productType, one Quote comes out. Left in place for the current
// frontend - superseded by /upload/extract-start once Phase 4 ships.
router.post('/upload/start', upload.single('file'), async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { productType, productId, source } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!productType) {
    return res.status(400).json({ error: 'productType is required' });
  }
  if (!productId || Number.isNaN(Number(productId))) {
    return res.status(400).json({ error: 'productId is required' });
  }
  if (!isValidSource(source)) {
    return res.status(400).json({ error: 'source must be "current" or "proposal"' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);
    formData.append('product_type', productType);

    const bucketRes = await fetch(`${BUCKET_URL}/upload`, {
      method: 'POST',
      body: formData,
    });

    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok || !bucketJson.job_id) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to start extraction' });
    }

    const jobId = bucketJson.job_id as string;
    pendingUploads.set(jobId, {
      dealId,
      productId: Number(productId),
      source,
      productType,
      fileBuffer: req.file.buffer,
      originalFilename: req.file.originalname,
      status: 'processing',
    });

    setTimeout(() => pollBucketJob(jobId), POLL_INTERVAL_MS);

    res.status(202).json({ jobId });
  } catch (err) {
    console.error('Failed to start upload:', err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// GET /api/deals/:dealId/quotes/upload/status/:jobId
// Read-only check against Node's own in-memory record for the
// single-product path.
router.get('/upload/status/:jobId', (req: Request, res: Response) => {
  const pending = pendingUploads.get(req.params.jobId);
  if (!pending) {
    return res.status(404).json({ status: 'error', error: 'Unknown or expired job' });
  }

  if (pending.status === 'processing') {
    return res.json({ status: 'processing', log: pending.log ?? [] });
  }
  if (pending.status === 'error') {
    return res.json({ status: 'error', error: pending.error });
  }
  return res.json({ status: 'done', quote: pending.quote });
});

// POST /api/deals/:dealId/quotes/upload/extract-start
// The new multi-product entry point: no pre-selected Product or rate
// type - drop a PDF, the Bucket classifies it and extracts every
// product it finds in one job (see /extract on the Bucket side). Same
// independent-background-poll pattern as /upload/start.
router.post('/upload/extract-start', upload.single('file'), async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { source } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!isValidSource(source)) {
    return res.status(400).json({ error: 'source must be "current" or "proposal"' });
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer]), req.file.originalname);

    const bucketRes = await fetch(`${BUCKET_URL}/extract`, {
      method: 'POST',
      body: formData,
    });

    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok || !bucketJson.job_id) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to start extraction' });
    }

    const jobId = bucketJson.job_id as string;
    pendingExtractJobs.set(jobId, {
      dealId,
      source,
      fileBuffer: req.file.buffer,
      originalFilename: req.file.originalname,
      status: 'processing',
    });

    setTimeout(() => pollBucketExtractJob(jobId), POLL_INTERVAL_MS);

    res.status(202).json({ jobId });
  } catch (err) {
    console.error('Failed to start extraction:', err);
    res.status(500).json({ error: 'Failed to start extraction' });
  }
});

// GET /api/deals/:dealId/quotes/upload/extract-status/:jobId
router.get('/upload/extract-status/:jobId', (req: Request, res: Response) => {
  const pending = pendingExtractJobs.get(req.params.jobId);
  if (!pending) {
    return res.status(404).json({ status: 'error', error: 'Unknown or expired job' });
  }

  if (pending.status === 'processing') {
    return res.json({ status: 'processing', log: pending.log ?? [] });
  }
  if (pending.status === 'error') {
    return res.json({ status: 'error', error: pending.error });
  }
  return res.json({
    status: 'done',
    carrier: pending.carrier,
    quotes: pending.quotes,
    skipped: pending.skipped,
  });
});

// POST /api/deals/:dealId/quotes/manual
router.post('/manual', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { productId, source, carrierName, notes, rates } = req.body;

  if (!productId || Number.isNaN(Number(productId))) {
    return res.status(400).json({ error: 'productId is required' });
  }
  if (!isValidSource(source)) {
    return res.status(400).json({ error: 'source must be "current" or "proposal"' });
  }
  if (!carrierName) {
    return res.status(400).json({ error: 'carrierName is required' });
  }

  try {
    const quote = await prisma.quote.create({
      data: {
        dealId,
        productId: Number(productId),
        source,
        carrierName,
        productType: 'manual',
        usedDiscovery: false,
        rawData: { notes: notes ?? null, rates: rates ?? null },
        warnings: null,
        xlsxPath: null,
      },
      include: { product: true },
    });

    res.status(201).json(quote);
  } catch (err) {
    console.error('Failed to create manual quote:', err);
    res.status(500).json({ error: 'Failed to create manual quote' });
  }
});

// GET /api/deals/:dealId/quotes/rate-template
// Downloads a blank rate-structure template — one tab per rate structure (Simple
// Tiered / Age-Banded / Flat Rate per Unit), plus an Instructions tab explaining
// which one to fill in. Not actually deal-specific — kept under this router purely
// so the frontend builds the URL the same way it builds every other quotes-scoped
// URL. See lib/rateTemplate.ts for the generation + parsing logic.
router.get('/rate-template', async (_req: Request, res: Response) => {
  try {
    const workbook = await buildRateTemplateWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="rate_template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Failed to build rate template:', err);
    res.status(500).json({ error: 'Failed to build rate template' });
  }
});

// POST /api/deals/:dealId/quotes/upload-template
// Alternative to POST /manual for when the agent already has the rates in a
// spreadsheet rather than typing them into the free-text box. Parses the filled-in
// rate-template workbook (lib/rateTemplate.ts) and creates a REAL
// simple_tiered/age_banded/flat_rate_per_unit Quote — not a "manual" one — so it
// aligns in the comparison workbook exactly like an uploaded carrier PDF would, with
// zero special-casing needed in comparisonEngine/. Synchronous (no Bucket involved,
// no job polling) since parsing a small spreadsheet is fast. Any notes typed
// alongside the file land in this quote's own `supplement.notes`, the same slot
// PATCH /:id/supplement writes to, rather than needing a separate field.
router.post('/upload-template', upload.single('file'), async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { productId, source, carrierName, notes } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!productId || Number.isNaN(Number(productId))) {
    return res.status(400).json({ error: 'productId is required' });
  }
  if (!isValidSource(source)) {
    return res.status(400).json({ error: 'source must be "current" or "proposal"' });
  }
  if (!carrierName) {
    return res.status(400).json({ error: 'carrierName is required' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const result = parseRateTemplateWorkbook(workbook, carrierName);
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }

    const quote = await prisma.quote.create({
      data: {
        dealId,
        productId: Number(productId),
        source,
        carrierName,
        productType: result.productType,
        usedDiscovery: false,
        rawData: result.rawData as any,
        warnings: result.warnings.length > 0 ? result.warnings : null,
        xlsxPath: null,
        supplement: notes ? { notes, rates: null } : undefined,
      },
      include: { product: true },
    });

    res.status(201).json(quote);
  } catch (err) {
    console.error('Failed to parse rate template upload:', err);
    res
      .status(500)
      .json({ error: "Failed to parse the uploaded template — make sure it's the .xlsx file downloaded from here." });
  }
});

// PATCH /api/deals/:dealId/quotes/:id
// Lightweight corrections that DON'T require re-extraction - right now,
// just reassigning which catalog Product this line maps to. The
// classifier's original productLabel guess is never overwritten here,
// so it stays visible for review even after the Product is corrected.
// Rate Type corrections go through POST /:id/reprocess instead, since
// changing rate type changes the SHAPE of rawData (different schema per
// rate_type), not just a label - it has to be re-extracted, not relabeled.
router.patch('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { productId, reason } = req.body;

  if (productId === undefined) {
    return res.status(400).json({ error: 'Nothing to update - only productId is supported here' });
  }

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const newProductId = productId === null ? null : Number(productId);
    if (newProductId !== null && Number.isNaN(newProductId)) {
      return res.status(400).json({ error: 'productId must be a number or null' });
    }

    const [quote] = await prisma.$transaction([
      prisma.quote.update({
        where: { id },
        data: { productId: newProductId },
        include: { product: true },
      }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'productId',
          fromValue: existing.productId === null ? null : String(existing.productId),
          toValue: newProductId === null ? null : String(newProductId),
          reason: reason ?? null,
        },
      }),
    ]);

    res.json(quote);
  } catch (err) {
    console.error('Failed to update quote:', err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// PATCH /api/deals/:dealId/quotes/:id/plan-selection
// A single carrier document can list a couple dozen plan/product variations in one
// Quote (a 20-option medical proposal is the real case this was built for) - the
// agent picks which ones actually belong in the comparison via the "Plans Shown"
// picker on the frontend, without deleting the rest or touching rawData. `included`
// is an allow-list of zero-based array indices into rawData.plans[]/products[] -
// NOT names, since two plans in the same document can share an identical name (an
// earlier, name-keyed version of this broke exactly on that case). `included: null`
// clears the selection (back to showing everything, the original default). Applied
// uniformly across every build in tabBuilder.ts, not just the Final export - see
// QuoteRecord.planSelection in comparisonEngine/types.ts.
router.patch('/:id/plan-selection', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { included, reason } = req.body;

  if (included !== null && (!Array.isArray(included) || !included.every((i) => Number.isInteger(i)))) {
    return res.status(400).json({ error: 'included must be an array of integer indices, or null' });
  }

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const planSelection = included === null ? null : { included };

    const [quote] = await prisma.$transaction([
      prisma.quote.update({
        where: { id },
        data: { planSelection },
        include: { product: true },
      }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'planSelection',
          fromValue: existing.planSelection ? JSON.stringify(existing.planSelection) : null,
          toValue: planSelection ? JSON.stringify(planSelection) : null,
          reason: reason ?? null,
        },
      }),
    ]);

    res.json(quote);
  } catch (err) {
    console.error('Failed to update plan selection:', err);
    res.status(500).json({ error: 'Failed to update plan selection' });
  }
});

// PATCH /api/deals/:dealId/quotes/:id/supplement
// Fills gaps on a row that already extracted (a rate that came through missing) or
// adds context the extractor wouldn't know to ask for - stored separately from
// rawData, which stays exactly what the Bucket actually returned, so a manual
// addition never gets confused with a real extraction result. Overwrites any
// previous supplement wholesale rather than merging field by field: the "Add/edit
// details" modal on the frontend always sends the complete current state (it
// pre-fills its textarea from the existing supplement before the user edits), so
// this is never a partial update in practice. Folded into the comparison workbook
// as extra rows in this same quote's own column - see comparisonEngine/tabBuilder.ts.
router.patch('/:id/supplement', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { notes, rates, reason } = req.body;

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const supplement = notes || rates ? { notes: notes ?? null, rates: rates ?? null } : null;

    const [quote] = await prisma.$transaction([
      prisma.quote.update({
        where: { id },
        data: { supplement },
        include: { product: true },
      }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'supplement',
          fromValue: existing.supplement ? JSON.stringify(existing.supplement) : null,
          toValue: supplement ? JSON.stringify(supplement) : null,
          reason: reason ?? null,
        },
      }),
    ]);

    res.json(quote);
  } catch (err) {
    console.error('Failed to update quote supplement:', err);
    res.status(500).json({ error: 'Failed to update quote supplement' });
  }
});

// PATCH /api/deals/:dealId/quotes/:id/supplement/upload-template
// Same idea as POST /upload-template, but for filling gaps on a row that already
// exists instead of creating a new one — the template-upload counterpart to
// PATCH /:id/supplement's free-text box. A supplement always layers onto one
// already-existing quote's own column(s) (see tabBuilder.ts), so the parsed
// template is flattened into the same label/value dict `rates` already expects
// rather than becoming a second, independently-columned quote. Any notes typed
// alongside the file are kept as-is, same as the free-text path.
router.patch('/:id/supplement/upload-template', upload.single('file'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { notes, reason } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const result = parseRateTemplateWorkbook(workbook, existing.carrierName);
    if ('error' in result) {
      return res.status(400).json({ error: result.error });
    }

    const rates = flattenRateTemplateResult(result);
    const supplement = { notes: notes ?? null, rates: Object.keys(rates).length > 0 ? rates : null };

    const [quote] = await prisma.$transaction([
      prisma.quote.update({
        where: { id },
        data: { supplement },
        include: { product: true },
      }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'supplement',
          fromValue: existing.supplement ? JSON.stringify(existing.supplement) : null,
          toValue: JSON.stringify(supplement),
          reason: reason ?? null,
        },
      }),
    ]);

    res.json({ ...quote, templateWarnings: result.warnings });
  } catch (err) {
    console.error('Failed to parse rate template for supplement:', err);
    res
      .status(500)
      .json({ error: "Failed to parse the uploaded template — make sure it's the .xlsx file downloaded from here." });
  }
});

// POST /api/deals/:dealId/quotes/:id/reprocess
// Used when a human corrects the Rate Type (or just wants to retry a
// bad extraction). Re-runs real extraction against the ORIGINAL PDF
// already on file - the user never has to re-upload. The old Quote is
// soft-excluded (not deleted), a QuoteCorrection is logged linking back
// to it, and a new Quote is created once the Bucket finishes. Returns a
// job_id - poll it exactly like /upload/status/:jobId, since it reuses
// the same single-product job path under the hood.
router.post('/:id/reprocess', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rateType, reason } = req.body;

  if (!rateType) {
    return res.status(400).json({ error: 'rateType is required' });
  }

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }
    if (!existing.originalPdfPath) {
      return res.status(400).json({ error: 'No original PDF on file for this quote - cannot reprocess' });
    }

    const fileBuffer = await fs.readFile(existing.originalPdfPath);
    const originalFilename = path.basename(existing.originalPdfPath);

    await prisma.$transaction([
      prisma.quote.update({ where: { id }, data: { excluded: true } }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'rateType',
          fromValue: existing.productType,
          toValue: rateType,
          reason: reason ?? null,
        },
      }),
    ]);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), originalFilename);
    formData.append('product_type', rateType);

    const bucketRes = await fetch(`${BUCKET_URL}/upload`, {
      method: 'POST',
      body: formData,
    });
    const bucketJson = await bucketRes.json();

    if (!bucketRes.ok || !bucketJson.job_id) {
      return res.status(502).json({ error: bucketJson.error || 'Failed to start reprocess' });
    }

    const jobId = bucketJson.job_id as string;
    pendingUploads.set(jobId, {
      dealId: existing.dealId,
      productId: existing.productId,
      productLabel: existing.productLabel,
      source: existing.source as QuoteSource,
      productType: rateType,
      fileBuffer,
      originalFilename,
      status: 'processing',
    });

    setTimeout(() => pollBucketJob(jobId), POLL_INTERVAL_MS);

    res.status(202).json({ jobId });
  } catch (err) {
    console.error('Failed to reprocess quote:', err);
    res.status(500).json({ error: 'Failed to reprocess quote' });
  }
});

// DELETE /api/deals/:dealId/quotes/:id
// Soft-exclude, not a hard delete - rawData and the corrections log stay
// intact for forensic value. excluded=true just removes it from GET /
// by default; nothing here actually erases a row.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { reason } = req.body ?? {};

  try {
    const existing = await prisma.quote.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Quote not found' });
    }
    if (existing.excluded) {
      return res.status(200).json({ ok: true, alreadyExcluded: true });
    }

    await prisma.$transaction([
      prisma.quote.update({ where: { id }, data: { excluded: true } }),
      prisma.quoteCorrection.create({
        data: {
          quoteId: id,
          field: 'excluded',
          fromValue: 'false',
          toValue: 'true',
          reason: reason ?? null,
        },
      }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete quote:', err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// GET /api/deals/:dealId/quotes/:id/download
router.get('/:id/download', async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  try {
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote || !quote.xlsxPath) {
      return res.status(404).json({ error: 'No file available for this quote' });
    }

    const bucketRes = await fetch(`${BUCKET_URL}${quote.xlsxPath}`);
    if (!bucketRes.ok || !bucketRes.body) {
      return res.status(502).json({ error: 'Failed to fetch file from the Bucket' });
    }

    const filename = quote.xlsxPath.split('/').pop() || `quote-${id}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const buffer = Buffer.from(await bucketRes.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error('Failed to proxy download:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// GET /api/deals/:dealId/quotes/:id/original
// The original PDF the user dropped in, opened inline for a quick
// side-by-side sanity check against the generated comparison.
router.get('/:id/original', async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  try {
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote || !quote.originalPdfPath) {
      return res.status(404).json({ error: 'No original file available for this quote' });
    }

    const buffer = await fs.readFile(quote.originalPdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  } catch (err) {
    console.error('Failed to serve original file:', err);
    res.status(500).json({ error: 'Failed to load original file' });
  }
});

export default router;