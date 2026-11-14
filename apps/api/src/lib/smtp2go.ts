// Destination: apps/api/src/lib/smtp2go.ts
//
// Minimal client for the SMTP2GO HTTP API (v3). Sends through the same
// SMTP2GO account the rest of the server uses, but over HTTPS with an API
// key instead of the SMTP relay on port 2525.
//
// Why the API rather than SMTP: every send returns an email_id, which can
// be stored and later used to look the message up in SMTP2GO (delivery,
// bounces, opens). The upcoming carrier-communication feature needs that.
//
// Environment (apps/api/.env):
//   SMTP2GO_API_KEY   required. API key from the SMTP2GO dashboard
//                     (Sending > API Keys). Never logged.
//   SMTP2GO_API_BASE  optional, for tests. Defaults to https://api.smtp2go.com/v3
//
// Env names match the Translatus app on the same server (C:\translator\
// shared\app.env), which uses the same SMTP2GO account and API key.
//   RFQ_FROM_EMAIL    default sender address. Must be a verified sender or
//   RFQ_FROM_NAME     domain on the SMTP2GO account, the same requirement
//                     as for SMTP.
//
// API reference: https://developers.smtp2go.com/docs/send-an-email
//   POST {base}/email/send, header X-Smtp2go-Api-Key
//   body: sender, to[], cc[], bcc[], subject, text_body, html_body,
//         custom_headers[{ header, value }],
//         attachments[{ filename, fileblob (base64), mimetype }]
//   200 -> { request_id, data: { succeeded, failed, failures[], email_id } }
//   4xx -> { request_id, data: { error_code, error } }
// Total message size limit is 50 MB, attachments included.
import fs from 'fs/promises';
import path from 'path';

export interface MailAddress {
  name?: string | null;
  email: string;
}

export interface MailAttachment {
  filename: string;
  // Either a local file path (read and base64-encoded here) or raw content.
  path?: string;
  content?: Buffer | string;
  mimetype?: string;
}

export interface SendEmailOptions {
  to: MailAddress | MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  from?: MailAddress; // defaults to RFQ_FROM_NAME / RFQ_FROM_EMAIL
  replyTo?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  headers?: Record<string, string>; // extra custom headers, e.g. X-PipeLine-Ref
}

export interface SendEmailResult {
  emailId: string | null;
  requestId: string | null;
  succeeded: number;
  failed: number;
  failures: unknown[];
}

export class Smtp2goError extends Error {
  status: number;
  code: string | null;
  requestId: string | null;
  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message);
    this.name = 'Smtp2goError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
};

export function isSmtp2goApiConfigured(): boolean {
  return !!process.env.SMTP2GO_API_KEY?.trim();
}

// RFC 5322 "Display Name <addr>". The name is quoted, and any quotes, angle
// brackets or line breaks in it are removed so a contact name can't inject
// headers or break the address.
export function formatAddress(a: MailAddress): string {
  const email = a.email.trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) {
    throw new Error(`Invalid email address: ${JSON.stringify(a.email)}`);
  }
  const name = (a.name ?? '').replace(/["<>\r\n]/g, '').trim();
  return name ? `"${name}" <${email}>` : email;
}

function defaultFrom(): MailAddress {
  const email = process.env.RFQ_FROM_EMAIL?.trim();
  if (!email) throw new Error('RFQ_FROM_EMAIL is not set');
  return { name: process.env.RFQ_FROM_NAME ?? null, email };
}

async function toApiAttachment(a: MailAttachment) {
  let buf: Buffer;
  if (a.path) buf = await fs.readFile(a.path);
  else if (a.content !== undefined) buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
  else throw new Error(`Attachment "${a.filename}" has neither path nor content`);
  const mimetype = a.mimetype ?? MIME_BY_EXT[path.extname(a.filename).toLowerCase()] ?? 'application/octet-stream';
  return { size: buf.length, payload: { filename: a.filename, fileblob: buf.toString('base64'), mimetype } };
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const apiKey = process.env.SMTP2GO_API_KEY?.trim();
  if (!apiKey) throw new Error('SMTP2GO_API_KEY is not set');
  const base = (process.env.SMTP2GO_API_BASE ?? 'https://api.smtp2go.com/v3').replace(/\/+$/, '');

  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  if (toList.length === 0) throw new Error('At least one recipient is required');
  if (!opts.text && !opts.html) throw new Error('Either text or html body is required');

  const customHeaders = Object.entries(opts.headers ?? {}).map(([header, value]) => ({ header, value }));
  if (opts.replyTo) customHeaders.push({ header: 'Reply-To', value: formatAddress(opts.replyTo) });

  const attachments = await Promise.all((opts.attachments ?? []).map(toApiAttachment));
  const attachmentBytes = attachments.reduce((n, a) => n + a.size, 0);
  // base64 inflates by ~4/3; keep a margin under SMTP2GO's 50 MB total.
  if (attachmentBytes * 1.37 > MAX_TOTAL_BYTES) {
    throw new Error(`Attachments total ${(attachmentBytes / 1048576).toFixed(1)} MB, too large for one email (50 MB limit after encoding)`);
  }

  const body: Record<string, unknown> = {
    sender: formatAddress(opts.from ?? defaultFrom()),
    to: toList.map(formatAddress),
    subject: opts.subject,
  };
  if (opts.cc?.length) body.cc = opts.cc.map(formatAddress);
  if (opts.bcc?.length) body.bcc = opts.bcc.map(formatAddress);
  if (opts.text) body.text_body = opts.text;
  if (opts.html) body.html_body = opts.html;
  if (customHeaders.length) body.custom_headers = customHeaders;
  if (attachments.length) body.attachments = attachments.map((a) => a.payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/email/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Smtp2go-Api-Key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`SMTP2GO API request failed: ${(err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  const data = json?.data ?? {};
  const requestId = json?.request_id ?? null;

  if (!res.ok || data.error) {
    throw new Smtp2goError(
      `SMTP2GO API error ${res.status}${data.error_code ? ` ${data.error_code}` : ''}: ${data.error ?? res.statusText}`,
      res.status, data.error_code ?? null, requestId,
    );
  }

  const result: SendEmailResult = {
    emailId: data.email_id ?? null,
    requestId,
    succeeded: Number(data.succeeded ?? 0),
    failed: Number(data.failed ?? 0),
    failures: Array.isArray(data.failures) ? data.failures : [],
  };
  if (result.succeeded === 0 || result.failed > 0) {
    throw new Smtp2goError(
      `SMTP2GO accepted the request but ${result.failed} recipient(s) failed: ${JSON.stringify(result.failures)}`,
      res.status, 'RECIPIENT_FAILED', requestId,
    );
  }
  return result;
}
