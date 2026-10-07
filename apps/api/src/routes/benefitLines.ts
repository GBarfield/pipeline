// Destination: apps/api/src/routes/benefitLines.ts
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';
export default createCrudRouter(prisma.product, { writeRoles: ['SUPER_USER'] });