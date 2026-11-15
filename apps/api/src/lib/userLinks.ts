// Destination: apps/api/src/lib/userLinks.ts
//
// The account emails, same as Translatus (C:\translator apps/web/lib/
// user-links.ts): welcome, a new password, a new authenticator app. Written
// for people who have never used an authenticator app. They get one link and
// never the QR code: that is shown on the page the link opens, after the
// password.
//
// Emails go out right away through lib/mailer.ts (SMTP2GO). If one can't be
// sent, emailed=false and the Users page shows the link to pass on another
// way.
//
// Sender (apps/api/.env), separate from the RFQ sender:
//   ACCOUNT_FROM_EMAIL  e.g. info@benebloc.com. Default: RFQ_FROM_EMAIL.
//   ACCOUNT_FROM_NAME   default "PipeLine".
//   ACCOUNT_REPLY_TO    where replies go. Default: ACCOUNT_FROM_EMAIL. Set it
//                       to a real inbox if the From address has no mailbox.
// Any address on benebloc.com works: the whole domain is verified in SMTP2GO.
import { prisma } from './prisma.ts';
import { sendMail } from './mailer.ts';
import {
  createLink, LINK_HOURS, linkUrl, resetAuthenticator, siteUrl, TwoStepError, type LinkKind,
} from './twoStep.ts';

export type Actor = { id: number; name: string };

const APP_STEP =
  'Get the app. On your phone, open the App Store (iPhone) or Google Play (Android). Search for "authenticator" and install a free ' +
  'authenticator app, such as Google Authenticator or Microsoft Authenticator. If you already have one, you can use it.';
const SCAN_STEP =
  'The page will show a square black-and-white code (a QR code). On your phone, open the authenticator app, tap the + (plus) button, ' +
  'choose "Scan a QR code", and point your phone\'s camera at the code on your screen.';
const CODE_STEP = 'The app will now show "PipeLine" with a 6-digit number. Type that number on the page and click Finish. You\'re done.';
const PHONE_TIP =
  'Reading this on your phone? That\'s OK. Open the link on your phone, and the page will give you a button that adds PipeLine to the app for you, instead of scanning.';

const signInTip = () =>
  `From now on, sign in at ${siteUrl()} with your email and password. Then open the authenticator app and type the 6-digit number it shows for PipeLine. The number changes every 30 seconds; that's normal, just use the one showing now.`;

const usDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });

/** Plain-text email in the same shape as Translatus's Message (greeting, paragraphs, numbered steps, link, small print). */
function render(m: { greeting: string; paragraphs: string[]; steps?: string[]; button: { label: string; url: string }; after: string[] }): string {
  const parts = [m.greeting, ...m.paragraphs];
  if (m.steps?.length) parts.push(m.steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n'));
  parts.push(`${m.button.label}:\n${m.button.url}`, ...m.after, 'PipeLine', '--\nSent by PipeLine');
  return parts.join('\n\n') + '\n';
}

/** Composes and sends the email for a link. False when it couldn't be sent (the Users page then shows the link to copy). */
async function emailLink(actor: Actor | null, userId: number, kind: LinkKind, token: string, expiresAt: Date, selfService: boolean): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (!u) return false;
  const who = actor?.name || 'Your administrator';
  const url = linkUrl(token);
  const until = kind === 'password' && selfService ? 'for 1 hour' : `until ${usDate(expiresAt)}`;
  const first = u.name?.trim().split(' ')[0];
  const greeting = first ? `Hello ${first},` : 'Hello,';
  let subject: string;
  let body: string;

  if (kind === 'welcome') {
    subject = 'Your PipeLine account is ready: set it up';
    body = render({
      greeting,
      paragraphs: [
        `${who} made you an account on PipeLine, BeneBloc's benefits administration system.`,
        "PipeLine has private information about people, so signing in takes two things: your password, and a 6-digit number from an app on your phone. Setting this up takes about 5 minutes. Here's how:",
      ],
      steps: [
        APP_STEP,
        'On a computer, open the link below (Set up my account). Choose a password of at least 12 characters and type it twice.',
        SCAN_STEP,
        CODE_STEP,
      ],
      button: { label: 'Set up my account', url },
      after: [
        PHONE_TIP,
        `This link works once, ${until}. If it stops working, ask ${who} to send you a new one.`,
        signInTip(),
        "Didn't expect this email? You can ignore it.",
      ],
    });
  } else if (kind === 'password') {
    subject = 'Choose a new PipeLine password';
    body = render({
      greeting,
      paragraphs: selfService
        ? ['Someone asked to reset the password for your PipeLine account. If it was you, open the link below and choose a new password.']
        : [`${who} sent you a link to choose a new password for your PipeLine account. Open the link below and choose a new password.`],
      button: { label: 'Choose a new password', url },
      after: [
        `This link works once, ${until}.`,
        "You will still need the 6-digit number from your authenticator app to sign in. Your app doesn't change.",
        selfService ? "Didn't ask for this? You can ignore this email. Your password stays the same." : "Didn't expect this email? You can ignore it.",
      ],
    });
  } else {
    subject = 'Set up your authenticator app for PipeLine again';
    body = render({
      greeting,
      paragraphs: [
        `${who} reset the authenticator app for your PipeLine account, probably because you have a new phone. Your password hasn't changed. Here's how to set up the app again:`,
      ],
      steps: [
        APP_STEP,
        'On a computer, open the link below (Set up my app). Type your PipeLine password.',
        SCAN_STEP + ' If the app still has an old PipeLine entry, you can delete it.',
        CODE_STEP,
      ],
      button: { label: 'Set up my app', url },
      after: [
        PHONE_TIP,
        `This link works once, ${until}. If it stops working, ask ${who} to send you a new one.`,
        'Forgot your password too? Click "Forgot your password?" on the sign-in page first, then come back to this email.',
      ],
    });
  }

  const fromEmail = process.env.ACCOUNT_FROM_EMAIL?.trim() || process.env.RFQ_FROM_EMAIL?.trim() || '';
  const fromName = process.env.ACCOUNT_FROM_NAME?.trim() || 'PipeLine';
  const replyTo = process.env.ACCOUNT_REPLY_TO?.trim() || fromEmail;
  try {
    await sendMail({
      to: { name: u.name, email: u.email },
      replyTo: { name: fromName, email: replyTo },
      fromName,
      fromEmail,
      subject,
      body,
      attachments: [],
    });
    console.log(`[account-links] ${kind} email sent to user ${userId}`);
    return true;
  } catch (err) {
    console.error(`[account-links] ${kind} email to user ${userId} failed:`, (err as Error).message);
    return false;
  }
}

type LinkResult = { email: string; emailed: boolean; kind: LinkKind; url: string; expiresAt: Date };

/** Emails the welcome link to a user who was just added. */
export async function sendWelcome(actor: Actor, userId: number): Promise<LinkResult> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const { token, expiresAt } = await createLink(userId, 'welcome', actor.id, LINK_HOURS.welcome);
  const emailed = await emailLink(actor, userId, 'welcome', token, expiresAt, false);
  return { email: u.email, emailed, kind: 'welcome', url: linkUrl(token), expiresAt };
}

/** A Super User sends a link: the welcome link again for someone who never finished, otherwise a new password link. */
export async function sendPasswordLink(actor: Actor, userId: number): Promise<LinkResult> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, active: true, passwordHash: true } });
  if (!u) throw new TwoStepError('User not found.', 404);
  if (!u.active) throw new TwoStepError(`${u.email} can't sign in. Turn Active back on first.`);
  const kind: LinkKind = u.passwordHash ? 'password' : 'welcome';
  const { token, expiresAt } = await createLink(userId, kind, actor.id, kind === 'welcome' ? LINK_HOURS.welcome : LINK_HOURS.adminPassword);
  const emailed = await emailLink(actor, userId, kind, token, expiresAt, false);
  return { email: u.email, emailed, kind, url: linkUrl(token), expiresAt };
}

/** Lost phone: clears their authenticator, signs them out and emails the link to set up a new one. */
export async function resetAndEmail(actor: Actor | null, userId: number): Promise<LinkResult> {
  if (actor && userId === actor.id) throw new TwoStepError('Another Super User has to reset your authenticator.');
  const { email } = await resetAuthenticator(userId);
  const { token, expiresAt } = await createLink(userId, 'authenticator', actor?.id ?? null, LINK_HOURS.authenticator);
  const emailed = await emailLink(actor, userId, 'authenticator', token, expiresAt, false);
  console.log(`[account-links] authenticator reset for user ${userId} by ${actor ? `user ${actor.id}` : 'server command'}; emailed=${emailed}`);
  return { email, emailed, kind: 'authenticator', url: linkUrl(token), expiresAt };
}

/** "Forgot your password?" Says nothing about whether the email has an account. 3 an hour per address. */
const asked = new Map<string, number[]>();
export async function forgotPassword(rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const now = Date.now();
  const recent = (asked.get(email) ?? []).filter((t) => t > now - 3_600_000);
  if (recent.length >= 3) return;
  asked.set(email, [...recent, now]);
  const u = await prisma.user.findUnique({ where: { email }, select: { id: true, active: true, passwordHash: true } });
  if (!u || !u.active) return;
  // Never finished the welcome email? Send that again: it sets the password and then the app.
  const kind: LinkKind = u.passwordHash ? 'password' : 'welcome';
  const { token, expiresAt } = await createLink(u.id, kind, null, kind === 'welcome' ? LINK_HOURS.welcome : LINK_HOURS.password);
  await emailLink(null, u.id, kind, token, expiresAt, true);
  console.log(`[account-links] user ${u.id} asked for a ${kind} link`);
}
