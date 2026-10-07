// Destination: apps/api/src/routes/brokers.ts
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';

export default createCrudRouter(prisma.broker, {
  include: { carrier: true },
  writeRoles: ['SUPER_USER'],
  scope: (user) => (user.role === 'SUPER_USER' ? undefined : { id: user.brokerId ?? -1 }),
});