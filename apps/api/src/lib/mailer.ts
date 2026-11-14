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
  // Display name on the From line; the address is always RFQ_FROM_EMAIL.
  // Defaults to RFQ_FROM_NAME.
  fromName?: string | null;
}): Promise<{ transport: MailTransport; emailId: string | null }> {
  const fromName = opts.fromName?.trim() || process.env.RFQ_FROM_NAME || null;
  if (mailTransport() === 'api') {
    const r = await sendEmail({
      to: opts.to,
      from: { name: fromName, email: process.env.RFQ_FROM_EMAIL ?? '' },
      replyTo: opts.replyTo,
      subject: opts.subject,
      text: opts.body,
      attachments: opts.attachments.map((a) => ({ filename: a.filename, path: a.path })),
    });
    return { transport: 'api', emailId: r.emailId };
  }

  await smtp().sendMail({
    from: `"${(fromName ?? '').replace(/["<>\r\n]/g, '')}" <${process.env.RFQ_FROM_EMAIL}>`,
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
