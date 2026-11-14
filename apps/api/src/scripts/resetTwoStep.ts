// Destination: apps/api/src/scripts/resetTwoStep.ts
//
// Last-resort reset of someone's authenticator, run on the server, for when
// no other Super User can do it from the Users page (e.g. the only Super User
// lost their phone). Same effect as the Users page button: clears the
// authenticator, signs them out everywhere, emails a one-time link, and also
// prints the link here.
//
// Usage (from apps/api):  pnpm two-step:reset someone@benebloc.com
import 'dotenv/config';
import { prisma } from '../lib/prisma.ts';
import { resetAuthenticator } from '../lib/twoStep.ts';

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email) throw new Error('Usage: pnpm two-step:reset <email>');
  const u = await prisma.user.findUnique({ where: { email }, select: { id: true, active: true } });
  if (!u) throw new Error(`No user with email ${email}`);
  if (!u.active) throw new Error(`${email} is not active`);
  const r = await resetAuthenticator(u.id, null);
  console.log(`Reset the authenticator for ${r.email} and signed them out.`);
  console.log(r.emailed ? 'Emailed them the setup link.' : 'The email did NOT go out. Give them this link another way:');
  console.log(`Link (works once, until ${r.expiresAt.toISOString()}):\n${r.url}`);
}

main()
  .catch((err) => { console.error(`[two-step:reset] ${(err as Error).message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
