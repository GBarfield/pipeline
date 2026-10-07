// Destination: apps/api/src/routes/groupProposals.ts
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessDeal } from '../lib/scope.ts';
import { sendMail } from '../lib/mailer.ts';
import {
  exportComparisonWorkbook,
  type ComparisonPrismaClient,
} from '../lib/comparisonEngine/orchestrator.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const dealId = Number(req.params.dealId);
  if (!(await canAccessDeal(req.user!, dealId, res))) return;
  next();
});

// Structural cast, same as comparison.ts - the generated Prisma client
// satisfies ComparisonPrismaClient's shape once the relevant models/includes
// are in place.
const db = prisma as unknown as ComparisonPrismaClient;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

// Same convention as rfqs.ts's RFQ_ATTACHMENTS_DIR - local storage, not the
// Bucket (a proposal attachment is emailed as-is, never parsed).
const GROUP_PROPOSAL_ATTACHMENTS_DIR = path.join(process.cwd(), 'uploads', 'group-proposal');

async function ensureGroupProposalAttachmentsDir() {
  await fs.mkdir(GROUP_PROPOSAL_ATTACHMENTS_DIR, { recursive: true });
}

// GET /api/deals/:dealId/proposals
router.get('/', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  try {
    const proposals = await prisma.groupProposal.findMany({
      where: { dealId },
      include: {
        groupContact: true,
        attachments: true,
        notes: {
          orderBy: { createdAt: 'desc' },
          include: { author: { select: { id: true, name: true } } },
        },
        sentByUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(proposals);
  } catch (err) {
    console.error('Failed to list group proposals:', err);
    res.status(500).json({ error: 'Failed to list group proposals' });
  }
});

// POST /api/deals/:dealId/proposals
// Body: { groupContactId?, productIds: number[], subject, body }
router.post('/', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const { groupContactId, productIds, subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  try {
    const proposal = await prisma.groupProposal.create({
      data: {
        dealId,
        groupContactId: groupContactId ? Number(groupContactId) : null,
        productIds: productIds ?? [],
        subject,
        body,
        status: 'draft',
      },
    });
    res.status(201).json(proposal);
  } catch (err) {
    console.error('Failed to create group proposal:', err);
    res.status(500).json({ error: 'Failed to create group proposal' });
  }
});

// PATCH /api/deals/:dealId/proposals/:id
router.patch('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { groupContactId, productIds, subject, body, status, statusNote } = req.body;

  try {
    const proposal = await prisma.groupProposal.update({
      where: { id },
      data: {
        ...(groupContactId !== undefined ? { groupContactId } : {}),
        ...(productIds !== undefined ? { productIds } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(status !== undefined ? { status, statusUpdatedAt: new Date() } : {}),
        ...(statusNote !== undefined ? { statusNote } : {}),
      },
    });
    res.json(proposal);
  } catch (err) {
    console.error('Failed to update group proposal:', err);
    res.status(500).json({ error: 'Failed to update group proposal' });
  }
});

// POST /api/deals/:dealId/proposals/:id/attachments  (multipart, field name "file")
router.post('/:id/attachments', upload.single('file'), async (req: Request, res: Response) => {
  const proposalId = Number(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    await ensureGroupProposalAttachmentsDir();
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storedFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const storedPath = path.join(GROUP_PROPOSAL_ATTACHMENTS_DIR, storedFilename);
    await fs.writeFile(storedPath, req.file.buffer);

    const attachment = await prisma.groupProposalAttachment.create({
      data: {
        groupProposalId: proposalId,
        fileName: req.file.originalname,
        filePath: storedPath,
        source: 'uploaded',
      },
    });
    res.status(201).json(attachment);
  } catch (err) {
    console.error('Failed to save group proposal attachment:', err);
    res.status(500).json({ error: 'Failed to save group proposal attachment' });
  }
});

// POST /api/deals/:dealId/proposals/:id/attach-comparison
// One-click alternative to /attachments: builds the Deal's current combined
// comparison workbook - the exact same exportComparisonWorkbook() call
// comparison.ts's GET /export uses, with no source filter (the full
// current-vs-proposed sheet, same as the Final Proposal panel's own export
// button) - and saves a copy in as a real attachment, same as an uploaded
// file. This is a frozen copy, not a live link: if the comparison is later
// rebuilt with different data, this attachment stays exactly what was
// actually attached (and, once sent, exactly what was actually emailed) -
// same reasoning as Rfq freezing its own final body onto Rfq.body after send.
router.post('/:id/attach-comparison', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const proposalId = Number(req.params.id);

  try {
    const { buffer, filename } = await exportComparisonWorkbook(db, dealId, undefined);

    await ensureGroupProposalAttachmentsDir();
    const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storedFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    const storedPath = path.join(GROUP_PROPOSAL_ATTACHMENTS_DIR, storedFilename);
    await fs.writeFile(storedPath, buffer);

    const attachment = await prisma.groupProposalAttachment.create({
      data: {
        groupProposalId: proposalId,
        fileName: filename,
        filePath: storedPath,
        source: 'comparison',
      },
    });
    res.status(201).json(attachment);
  } catch (err) {
    console.error('Failed to attach comparison spreadsheet:', err);
    res.status(500).json({ error: 'Failed to attach comparison spreadsheet' });
  }
});

// POST /api/deals/:dealId/proposals/:id/send
router.post('/:id/send', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { sendWithoutAttachment } = req.body ?? {};

  try {
    const proposal = await prisma.groupProposal.findUnique({
      where: { id },
      include: { groupContact: true, attachments: true },
    });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!proposal.groupContact) return res.status(400).json({ error: 'Proposal has no contact selected' });
    if (proposal.attachments.length === 0 && !sendWithoutAttachment) {
      return res.status(400).json({ error: 'No attachments - pass sendWithoutAttachment to send anyway' });
    }

    const products = proposal.productIds.length > 0
      ? await prisma.product.findMany({ where: { id: { in: proposal.productIds } } })
      : [];
    const finalBody = products.length > 0
      ? `${proposal.body}\n\nProducts included in this comparison: ${products.map((p) => p.name).join(', ')}`
      : proposal.body;

    await sendMail({
      to: { name: proposal.groupContact.name, email: proposal.groupContact.email },
      replyTo: { name: req.user!.name, email: req.user!.email },
      subject: proposal.subject,
      body: finalBody,
      attachments: proposal.attachments.map((a) => ({ filename: a.fileName, path: a.filePath })),
    });

    const updated = await prisma.groupProposal.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), sentByUserId: req.user!.id, body: finalBody },
    });
    res.json(updated);
  } catch (err) {
    console.error('Failed to send group proposal:', err);
    res.status(500).json({ error: 'Failed to send group proposal' });
  }
});

// POST /api/deals/:dealId/proposals/:id/notes
router.post('/:id/notes', async (req: Request, res: Response) => {
  const proposalId = Number(req.params.id);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });

  try {
    const created = await prisma.groupProposalNote.create({
      data: { groupProposalId: proposalId, authorId: req.user!.id, note },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('Failed to add group proposal note:', err);
    res.status(500).json({ error: 'Failed to add group proposal note' });
  }
});

// DELETE /api/deals/:dealId/proposals/:id  (draft only)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const proposal = await prisma.groupProposal.findUnique({ where: { id }, select: { status: true } });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft proposals can be deleted' });
    }
    await prisma.groupProposal.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete group proposal:', err);
    res.status(500).json({ error: 'Failed to delete group proposal' });
  }
});

export default router;