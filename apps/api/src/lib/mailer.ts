// Destination: apps/api/src/lib/mailer.ts
//
// Outbound email for RFQs and Group Proposals. Two transports, same
// SMTP2GO account:
//   - "api"  (preferred): SMTP2GO HTTP API, see smtp2go.ts. Returns the
//            SMTP2GO email_id for tracking.
//   - "smtp": the original nodemailer SMTP relay (SMTP2GO_HOST/PORT/USER/
//            PASS, port 2525). Kept as a fallback.
// Which one is used: MAIL_TRANSPORT=api|smtp if set; otherwise "api"
// whenever SMTP2GO_API_KEY is present, else "smtp". The env is read once
// at startup, so restart BenAdminAPI after changing it.
import nodemailer from 'nodemailer';
import { sendEmail, isSmtp2goApiConfigured } from './smtp2go.ts';

interface EmailAddress {
  name: string;
  email: string;
}

interface RfqEmailAttachment {
  filename: string;
  path: string;
}

export type MailTransport = 'api' | 'smtp';

// --- who an email is "from" ------------------------------------------------------
//
// Emails a person sends from PipeLine (RFQs, Group Proposals, Carrier
// Communication) pass `sentBy`. Rule, per Gregg 2026-11-15:
//   - sender on a verified domain (benebloc.com): From is the person,
//     "Pat Smith" <pat@benebloc.com>, and replies go straight to them.
//   - anyone else (e.g. a broker user with their own company's address):
//     From is "Pat Smith via BeneBloc" <system address>, Reply-To is the
//     person. Sending *as* an unverified domain would be rejected or land in
//     spam, since SMTP2GO can only sign mail for verified domains.
// Settings (apps/api/.env):
//   VERIFIED_SENDER_DOMAINS  comma list, default "benebloc.com"
//   SENDER_VIA_NAME          default "BeneBloc"
//   system address           ACCOUNT_FROM_EMAIL, else RFQ_FROM_EMAIL
export function verifiedSenderDomains(): string[] {
  return (process.env.VERIFIED_SENDER_DOMAINS ?? 'benebloc.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export function systemFromEmail(): string {
  return process.env.ACCOUNT_FROM_EMAIL?.trim() || process.env.RFQ_FROM_EMAIL?.trim() || '';
}

export function fromForSender(sentBy: EmailAddress): EmailAddress {
  const email = sentBy.email.trim();
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (verifiedSenderDomains().includes(domain)) return { name: sentBy.name, email };
  return { name: `${sentBy.name} via ${process.env.SENDER_VIA_NAME?.trim() || 'BeneBloc'}`, email: systemFromEmail() };
}

export function mailTransport(): MailTransport {
  const forced = process.env.MAIL_TRANSPORT?.trim().toLowerCase();
  if (forced === 'api' || forced === 'smtp') return forced;
  return isSmtp2goApiConfigured() ? 'api' : 'smtp';
}

let smtpTransporter: nodemailer.Transporter | null = null;
function smtp() {
  smtpTransporter ??= nodemailer.createTransport({
    host: process.env.SMTP2GO_HOST,
    port: Number(process.env.SMTP2GO_PORT ?? 2525),
    secure: false, // STARTTLS on 2525, not implicit TLS
    auth: {
      user: process.env.SMTP2GO_USER,
      pass: process.env.SMTP2GO_PASS,
    },
  });
  return smtpTransporter;
}

console.log(`[mailer] outbound email transport: ${mailTransport()}`);

// Returns the SMTP2GO email_id when sent via the API (null via SMTP).
// Callers that ignore the return value keep working unchanged.
export async function sendRfqEmail(opts: {
  to: EmailAddress;
  replyTo: EmailAddress;
  subject: string;
  body: string;
  attachments: RfqEmailAttachment[];
  // From line. Defaults to RFQ_FROM_NAME <RFQ_FROM_EMAIL>. Any address on a
  // domain verified in SMTP2GO works (benebloc.com is verified).
  fromName?: string | null;
  fromEmail?: string | null;
  // The PipeLine user sending it. When set, From follows fromForSender()
  // above and fromName/fromEmail are ignored.
  sentBy?: EmailAddress | null;
}): Promise<{ transport: MailTransport; emailId: string | null }> {
  const sender = opts.sentBy ? fromForSender(opts.sentBy) : null;
  const fromName = sender?.name ?? (opts.fromName?.trim() || process.env.RFQ_FROM_NAME || null);
  const fromEmail = sender?.email ?? (opts.fromEmail?.trim() || process.env.RFQ_FROM_EMAIL || '');
  if (mailTransport() === 'api') {
    const r = await sendEmail({
      to: opts.to,
      from: { name: fromName, email: fromEmail },
      replyTo: opts.replyTo,
      subject: opts.subject,
      text: opts.body,
      attachments: opts.attachments.map((a) => ({ filename: a.filename, path: a.path })),
    });
    return { transport: 'api', emailId: r.emailId };
  }

  await smtp().sendMail({
    from: `"${(fromName ?? '').replace(/["<>\r\n]/g, '')}" <${fromEmail}>`,
    replyTo: `"${opts.replyTo.name}" <${opts.replyTo.email}>`,
    to: `"${opts.to.name}" <${opts.to.email}>`,
    subject: opts.subject,
    text: opts.body,
    attachments: opts.attachments,
  });
  return { transport: 'smtp', emailId: null };
}

// sendRfqEmail's body was already fully generic (to/replyTo/subject/body/
// attachments, nothing RFQ-specific in it) - this alias lets the Group
// Proposal feature reuse it under an honest name without touching the
// working RFQ send path at all.
export const sendMail = sendRfqEmail;
