// Destination: apps/api/src/lib/mailer.ts
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP2GO_HOST,
  port: Number(process.env.SMTP2GO_PORT ?? 2525),
  secure: false, // STARTTLS on 2525, not implicit TLS
  auth: {
    user: process.env.SMTP2GO_USER,
    pass: process.env.SMTP2GO_PASS,
  },
});

interface EmailAddress {
  name: string;
  email: string;
}

interface RfqEmailAttachment {
  filename: string;
  path: string;
}

export async function sendRfqEmail(opts: {
  to: EmailAddress;
  replyTo: EmailAddress;
  subject: string;
  body: string;
  attachments: RfqEmailAttachment[];
}) {
  await transporter.sendMail({
    from: `"${process.env.RFQ_FROM_NAME}" <${process.env.RFQ_FROM_EMAIL}>`,
    replyTo: `"${opts.replyTo.name}" <${opts.replyTo.email}>`,
    to: `"${opts.to.name}" <${opts.to.email}>`,
    subject: opts.subject,
    text: opts.body,
    attachments: opts.attachments,
  });
}

// sendRfqEmail's body was already fully generic (to/replyTo/subject/body/
// attachments, nothing RFQ-specific in it) - this alias lets the Group
// Proposal feature reuse it under an honest name without touching the
// working RFQ send path at all.
export const sendMail = sendRfqEmail;