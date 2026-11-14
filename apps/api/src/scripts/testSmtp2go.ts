// Destination: apps/api/src/scripts/testSmtp2go.ts
//
// Sends one test email through the SMTP2GO HTTP API using apps/api/.env,
// to confirm the API key and sender are accepted before the API service
// relies on them. Prints the SMTP2GO email_id on success. Never prints the
// API key.
//
// Usage (from apps/api):
//   pnpm mail:test you@example.com
//   pnpm mail:test you@example.com --attach        (adds a small .txt attachment)
import 'dotenv/config';
import { sendEmail, isSmtp2goApiConfigured, Smtp2goError } from '../lib/smtp2go.ts';
import { mailTransport } from '../lib/mailer.ts';

async function main() {
  const to = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!to) throw new Error('Usage: pnpm mail:test <recipient@example.com> [--attach]');

  console.log(`[mail:test] SMTP2GO_API_KEY set: ${isSmtp2goApiConfigured() ? 'yes' : 'NO'}`);
  console.log(`[mail:test] sender: "${process.env.RFQ_FROM_NAME ?? ''}" <${process.env.RFQ_FROM_EMAIL ?? '(RFQ_FROM_EMAIL not set)'}>`);
  console.log(`[mail:test] API service would use transport: ${mailTransport()}`);

  const r = await sendEmail({
    to: { email: to },
    subject: `PipeLine SMTP2GO API test ${new Date().toISOString()}`,
    text: 'This is a test message from PipeLine (apps/api) sent through the SMTP2GO HTTP API.',
    headers: { 'X-PipeLine-Test': '1' },
    attachments: process.argv.includes('--attach')
      ? [{ filename: 'pipeline-test.txt', content: 'SMTP2GO attachment test from PipeLine.\n' }]
      : [],
  });
  console.log(`[mail:test] OK. email_id=${r.emailId} request_id=${r.requestId}`);
}

main().catch((err) => {
  if (err instanceof Smtp2goError) console.error(`[mail:test] FAILED: ${err.message} (request_id=${err.requestId})`);
  else console.error(`[mail:test] FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
});
