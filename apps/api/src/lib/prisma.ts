// Destination: apps/api/src/lib/prisma.ts
//
// NOTE: your prisma/schema.prisma generator uses a custom output path
// ("../generated/prisma", not the default @prisma/client package), so the
// client is imported from that generated folder instead.
import 'dotenv/config';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });