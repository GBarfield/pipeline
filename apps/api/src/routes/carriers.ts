// Destination: apps/api/src/routes/carriers.ts
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';

export default createCrudRouter(prisma.carrier, { writeRoles: ['SUPER_USER'] });