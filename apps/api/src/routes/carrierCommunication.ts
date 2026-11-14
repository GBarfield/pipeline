// Destination: apps/api/src/routes/carrierCommunication.ts
//
// Carrier Communication (Benefits Administration): send an email to one,
// several or all CarrierContacts of a Carrier/TPA, free-form or from a
// reusable canned message (MessageTemplate). Mounted at
// /api/carrier-communication.
//
// GET    /templates                  active canned messages
// POST   /templates                  { name, subject, body }
// PUT    /templates/:id              creator or Super User
// DELETE /templates/:id              soft delete (active=false), creator or Super User
// GET    /messages?carrierId=&limit= sent history, newest first
// POST   /messages                   send. Body: { carrierId, contactIds?: number[],
//                                     allContacts?: boolean, groupId?, templateId?,
//                                     subject, body }
//
// Sending: one email per contact (so each is personalized and tracked on its
// own), synchronously, through lib/mailer.ts (SMTP2GO API when configured).
// From: CARRIER_COMM_FROM_NAME (else RFQ_FROM_NAME) <RFQ_FROM_EMAIL>;
// Reply-To: the user who sent it, so replies land in their own inbox.
//
// Access: any signed-in user, except one restricted to a division other
// than Benefits Administration. A Broker User can only attach a group of
// their own broker and only sees history sent by users of their broker.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';
import { sendMail } from '../lib/mailer.ts';
import { renderPlaceholders } from '../lib/placeholders.ts';

const router = Router();
router.use(requireAuth);

const DIVISION_KEY = 'BENEFITS_ADMINISTRATION';
const MAX_RECIPIENTS = 50;
let divisionIdCache: number | null = null;

async function divisionId(): Promise<number> {
  if (divisionIdCache === null) {
    const d = await prisma.division.findUniqueOrThrow({ where: { key: DIVISION_KEY } });
    divisionIdCache = d.id;
  }
  return divisionIdCache;
}

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = await divisionId();
    const restricted = req.user!.restrictedDivisionId;
    if (restricted !== null && restricted !== id) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch (err) {
    console.error('[carrier-communication] division lookup failed:', err);
    res.status(500).json({ error: 'Benefits Administration division not found' });
  }
});

const isSuper = (req: Request) => req.user!.role === 'SUPER_USER';
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// --- canned messages ---------------------------------------------------------

router.get('/templates', async (_req, res) => {
  try {
    const rows = await prisma.messageTemplate.findMany({
      where: { active: true },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(rows);
  } catch (err) {
    console.error('[carrier-communication] list templates:', err);
    res.status(500).json({ error: 'Failed to list canned messages' });
  }
});

function templateInput(body: any): { name: string; subject: string; body: string } | string {
  const name = str(body?.name).trim();
  const subject = str(body?.subject).replace(/[\r\n]+/g, ' ').trim();
  const text = str(body?.body);
  if (!name) return 'Name is required';
  if (!subject) return 'Subject is required';
  if (!text.trim()) return 'Message is required';
  if (name.length > 120 || subject.length > 200) return 'Name or subject is too long';
  return { name, subject, body: text };
}

router.post('/templates', async (req, res) => {
  const input = templateInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  try {
    const row = await prisma.messageTemplate.create({ data: { ...input, createdById: req.user!.id } });
    res.status(201).json(row);
  } catch (err) {
    console.error('[carrier-communication] create template:', err);
    res.status(500).json({ error: 'Failed to save canned message' });
  }
});

async function loadOwnTemplate(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? await prisma.messageTemplate.findUnique({ where: { id } }) : null;
  if (!row || !row.active) { res.status(404).json({ error: 'Canned message not found' }); return null; }
  if (!isSuper(req) && row.createdById !== req.user!.id) {
    res.status(403).json({ error: 'Only the person who created this canned message (or a Super User) can change it' });
    return null;
  }
  return row;
}

router.put('/templates/:id', async (req, res) => {
  const input = templateInput(req.body);
  if (typeof input === 'string') return res.status(400).json({ error: input });
  try {
    const row = await loadOwnTemplate(req, res);
    if (!row) return;
    res.json(await prisma.messageTemplate.update({ where: { id: row.id }, data: input }));
  } catch (err) {
    console.error('[carrier-communication] update template:', err);
    res.status(500).json({ error: 'Failed to save canned message' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const row = await loadOwnTemplate(req, res);
    if (!row) return;
    await prisma.messageTemplate.update({ where: { id: row.id }, data: { active: false } });
    res.status(204).send();
  } catch (err) {
    console.error('[carrier-communication] delete template:', err);
    res.status(500).json({ error: 'Failed to delete canned message' });
  }
});

// --- history -------------------------------------------------------------------

router.get('/messages', async (req, res) => {
  const carrierId = Number(req.query.carrierId);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const where: any = { divisionId: await divisionId() };
  if (Number.isInteger(carrierId) && carrierId > 0) where.carrierId = carrierId;
  if (!isSuper(req)) where.brokerId = req.user!.brokerId ?? -1;
  try {
    const rows = await prisma.carrierMessage.findMany({
      where,
      include: {
        carrier: { select: { id: true, name: true, partnerType: true } },
        group: { select: { id: true, company: true } },
        template: { select: { id: true, name: true } },
        sentByUser: { select: { id: true, name: true, email: true } },
        recipients: {
          select: { id: true, toEmail: true, toName: true, status: true, error: true, sentAt: true, providerId: true, eventDetail: true },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(rows);
  } catch (err) {
    console.error('[carrier-communication] list messages:', err);
    res.status(500).json({ error: 'Failed to list sent messages' });
  }
});

// --- send ----------------------------------------------------------------------

router.post('/messages', async (req, res) => {
  const b = req.body ?? {};
  const carrierId = Number(b.carrierId);
  const subject = str(b.subject).replace(/[\r\n]+/g, ' ').trim();
  const body = str(b.body);
  const groupId = b.groupId === null || b.groupId === undefined || b.groupId === '' ? null : Number(b.groupId);
  const templateId = b.templateId === null || b.templateId === undefined || b.templateId === '' ? null : Number(b.templateId);
  const allContacts = b.allContacts === true;
  const contactIds: number[] = Array.isArray(b.contactIds) ? b.contactIds.map(Number).filter(Number.isInteger) : [];

  if (!Number.isInteger(carrierId)) return res.status(400).json({ error: 'Pick a carrier' });
  if (!subject) return res.status(400).json({ error: 'Subject is required' });
  if (subject.length > 200) return res.status(400).json({ error: 'Subject is too long' });
  if (!body.trim()) return res.status(400).json({ error: 'Message is required' });
  if (!allContacts && contactIds.length === 0) return res.status(400).json({ error: 'Pick at least one contact' });
  if (groupId !== null && !Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group' });
  if (groupId !== null && !(await canAccessGroup(req.user!, groupId, res))) return;

  try {
    const carrier = await prisma.carrier.findUnique({ where: { id: carrierId }, select: { id: true, name: true } });
    if (!carrier) return res.status(404).json({ error: 'Carrier not found' });

    const contacts = await prisma.carrierContact.findMany({
      where: { carrierId, active: true, ...(allContacts ? {} : { id: { in: contactIds } }) },
      orderBy: { name: 'asc' },
    });
    if (contacts.length === 0) return res.status(400).json({ error: 'This carrier has no active contacts to send to' });
    if (!allContacts && contacts.length !== new Set(contactIds).size) {
      return res.status(400).json({ error: 'One or more contacts were not found for this carrier' });
    }
    // Same address listed twice (e.g. one inbox under two titles) gets one email.
    const seen = new Set<string>();
    const unique = contacts.filter((c) => {
      const k = c.email.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length > MAX_RECIPIENTS) return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS})` });

    const group = groupId !== null ? await prisma.group.findUnique({ where: { id: groupId }, select: { company: true } }) : null;
    if (templateId !== null && !(await prisma.messageTemplate.findUnique({ where: { id: templateId }, select: { id: true } }))) {
      return res.status(400).json({ error: 'Canned message not found' });
    }

    const message = await prisma.carrierMessage.create({
      data: {
        carrierId, groupId, templateId, subject, body,
        divisionId: await divisionId(),
        sentByUserId: req.user!.id,
        brokerId: req.user!.brokerId,
      },
    });

    const fromName = process.env.CARRIER_COMM_FROM_NAME?.trim() || null;
    let sent = 0;
    const failures: { email: string; error: string }[] = [];

    for (const c of unique) {
      const vars = {
        contact_name: c.name,
        carrier_name: carrier.name,
        group_name: group?.company ?? '',
        sender_name: req.user!.name,
        sender_email: req.user!.email,
        today: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }),
      };
      const rSubject = renderPlaceholders(subject, vars).replace(/[\r\n]+/g, ' ');
      const rBody = renderPlaceholders(body, vars);
      const rec = await prisma.carrierMessageRecipient.create({
        data: { messageId: message.id, carrierContactId: c.id, toEmail: c.email.trim(), toName: c.name, subject: rSubject, body: rBody },
      });
      try {
        const r = await sendMail({
          to: { name: c.name, email: c.email.trim() },
          replyTo: { name: req.user!.name, email: req.user!.email },
          subject: rSubject,
          body: rBody,
          attachments: [],
          fromName,
        });
        await prisma.carrierMessageRecipient.update({
          where: { id: rec.id },
          data: { status: 'sent', transport: r.transport, providerId: r.emailId, sentAt: new Date() },
        });
        sent++;
      } catch (err) {
        const msg = ((err as Error).message || 'Send failed').slice(0, 500);
        await prisma.carrierMessageRecipient.update({ where: { id: rec.id }, data: { status: 'failed', error: msg } });
        failures.push({ email: c.email, error: msg });
        console.error(`[carrier-communication] message ${message.id} to ${c.email} failed: ${msg}`);
      }
    }

    res.status(sent > 0 ? 201 : 502).json({ messageId: message.id, sent, failed: failures.length, failures });
  } catch (err) {
    console.error('[carrier-communication] send:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
