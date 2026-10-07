// Destination: apps/api/prisma/seed.ts
//
// Bootstraps the first Super User. Run once, after the migration in Step 2
// has been applied. Reads credentials from env vars (Step 1) so nothing
// sensitive has to be typed into a file that might get committed.
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.ts';
import { hashPassword } from '../src/lib/auth.ts';

const DIVISIONS: { key: string; name: string; sortOrder: number }[] = [
  { key: 'MARKETING', name: 'Marketing', sortOrder: 0 },
  { key: 'ACCOUNTING', name: 'Accounting', sortOrder: 1 },
  { key: 'BENEFITS_ADMINISTRATION', name: 'Benefits Administration', sortOrder: 2 },
];

async function seedDivisions() {
  for (const d of DIVISIONS) {
    await prisma.division.upsert({
      where: { key: d.key },
      update: { name: d.name, sortOrder: d.sortOrder },
      create: d,
    });
  }

  const existingSetting = await prisma.appSetting.findUnique({ where: { id: 1 } });
  if (!existingSetting) {
    const marketing = await prisma.division.findUniqueOrThrow({ where: { key: 'MARKETING' } });
    // Default to Marketing so post-migration behavior matches what the app already showed.
    await prisma.appSetting.create({
      data: { id: 1, currentDivisionId: marketing.id },
    });
  }

  console.log('Divisions seeded.');
}

async function main() {
  const email = process.env.SUPERUSER_EMAIL;
  const password = process.env.SUPERUSER_PASSWORD;
  const name = process.env.SUPERUSER_NAME || 'Super User';

  if (!email || !password) {
    throw new Error('Set SUPERUSER_EMAIL and SUPERUSER_PASSWORD in apps/api/.env before seeding.');
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.log(`User ${email} already exists — skipping.`);
  } else {
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        name,
        role: 'SUPER_USER',
      },
    });

    console.log(`Created Super User: ${user.email} (id ${user.id})`);
  }

  await seedDivisions();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });