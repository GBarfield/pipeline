// Destination: apps/api/src/routes/rfqs.ts
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessDeal } from '../lib/scope.ts';
import { sendRfqEmail } from '../lib/mailer.ts';

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

// Same convention as quotes.ts's ORIGINALS_DIR - local storage, not the Bucket
// (RFQ attachments are just emailed as-is, nothing here ever gets extracted).
const RFQ_ATTACHMENTS_DIR = path.join(process.cwd(), 'uploads', 'rfq');

async function ensureRfqAttachmentsDir() {
  await fs.mkdir(RFQ_ATTACHMENTS_DIR, { recursive: true });
}

// GET /api/deals/:dealId/rfqs
router.get('/', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  try {
    const rfqs = await prisma.rfq.findMany({
      where: { dealId },
            include: {
        carrier: true,
        carrierContact: true,
        attachments: true,
        notes: {
          orderBy: { createdAt: 'desc' },
          include: { author: { select: { id: true, name: true } } },
        },
        sentByUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rfqs);
  } catch (err) {
    console.error('Failed to list RFQs:', err);
    res.status(500).json({ error: 'Failed to list RFQs' });
  }
});

// POST /api/deals/:dealId/rfqs
// Body: { carrierId, carrierContactId?, productIds: number[], subject, body }
router.post('/', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { carrierId, carrierContactId, productIds, subject, body } = req.body;

  if (!carrierId || !subject || !body) {
    return res.status(400).json({ error: 'carrierId, subject, and body are required' });
  }

  try {
    const rfq = await prisma.rfq.create({
      data: {
        dealId,
        carrierId: Number(carrierId),
        carrierContactId: carrierContactId ? Number(carrierContactId) : null,
        productIds: productIds ?? [],
        subject,
        body,
        status: 'draft',
      },
    });
    res.status(201).json(rfq);
  } catch (err) {
    console.error('Failed to create RFQ:', err);
    res.status(500).json({ error: 'Failed to create RFQ' });
  }
});

// PATCH /api/deals/:dealId/rfqs/:id
router.patch('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { carrierContactId, productIds, subject, body, status, statusNote } = req.body;

  try {
    const rfq = await prisma.rfq.update({
      where: { id },
      data: {
        ...(carrierContactId !== undefined ? { carrierContactId } : {}),
        ...(productIds !== undefined ? { productIds } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(status !== undefined ? { status, statusUpdatedAt: new Date() } : {}),
        ...(statusNote !== undefined ? { statusNote } : {}),
      },
    });
    res.json(rfq);
  } catch (err) {
    console.error('Failed to update RFQ:', err);
    res.status(500).json({ error: 'Failed to update RFQ' });
  }
});

// POST /api/deals/:dealId/rfqs/:id/attachments  (multipart, field name "file")
router.post('/:id/attachments', upload.single('file'), async (req: Request, res: Response) => {
  const rfqId = Number(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    await ensureRfqAttachmentsDir();
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storedFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const storedPath = path.join(RFQ_ATTACHMENTS_DIR, storedFilename);
    await fs.writeFile(storedPath, req.file.buffer);

    const attachment = await prisma.rfqAttachment.create({
      data: {
        rfqId,
        fileName: req.file.originalname,
        filePath: storedPath,
        source: 'uploaded',
      },
    });
    res.status(201).json(attachment);
  } catch (err) {
    console.error('Failed to save RFQ attachment:', err);
    res.status(500).json({ error: 'Failed to save RFQ attachment' });
  }
});

// POST /api/deals/:dealId/rfqs/:id/send
router.post('/:id/send', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { sendWithoutAttachment } = req.body;

  try {
    const rfq = await prisma.rfq.findUnique({
      where: { id },
      include: { carrierContact: true, attachments: true },
    });
    if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
    if (!rfq.carrierContact) return res.status(400).json({ error: 'RFQ has no contact selected' });
    if (rfq.attachments.length === 0 && !sendWithoutAttachment) {
      return res.status(400).json({ error: 'No attachments - pass sendWithoutAttachment to send anyway' });
    }

       const products = rfq.productIds.length > 0
      ? await prisma.product.findMany({ where: { id: { in: rfq.productIds } } })
      : [];
    const finalBody = products.length > 0
      ? `${rfq.body}\n\nProducts requested: ${products.map((p) => p.name).join(', ')}`
      : rfq.body;

    await sendRfqEmail({
      to: { name: rfq.carrierContact.name, email: rfq.carrierContact.email },
      replyTo: { name: req.user!.name, email: req.user!.email },
      sentBy: { name: req.user!.name, email: req.user!.email }, // From = the user (see mailer.ts fromForSender)
      subject: rfq.subject,
      body: finalBody,
      attachments: rfq.attachments.map((a) => ({ filename: a.fileName, path: a.filePath })),
    });

    const updated = await prisma.rfq.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), sentByUserId: req.user!.id, body: finalBody },
    });
    res.json(updated);
  } catch (err) {
    console.error('Failed to send RFQ:', err);
    res.status(500).json({ error: 'Failed to send RFQ' });
  }
});

// POST /api/deals/:dealId/rfqs/:id/notes
router.post('/:id/notes', async (req: Request, res: Response) => {
  const rfqId = Number(req.params.id);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });

  try {
    const created = await prisma.rfqNote.create({
      data: { rfqId, authorId: req.user!.id, note },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('Failed to add RFQ note:', err);
    res.status(500).json({ error: 'Failed to add RFQ note' });
  }
});

// DELETE /api/deals/:dealId/rfqs/:id  (draft only)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const rfq = await prisma.rfq.findUnique({ where: { id }, select: { status: true } });
    if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
    if (rfq.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft RFQs can be deleted' });
    }
    await prisma.rfq.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete RFQ:', err);
    res.status(500).json({ error: 'Failed to delete RFQ' });
  }
});

export default router;