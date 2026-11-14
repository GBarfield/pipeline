// Destination: apps/api/src/routes/carriers.ts
//
// GET /api/carriers                  -> partnerType CARRIER only (default, so
//                                      every existing carrier picker -- RFQs,
//                                      reconciliation filters, Groups/Brokers/
//                                      Products relations -- is unchanged)
// GET /api/carriers?type=TPA,VENDOR  -> just those types
// GET /api/carriers?type=ALL         -> every row
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';

const PARTNER_TYPES = ['CARRIER', 'TPA', 'VENDOR'];

export default createCrudRouter(prisma.carrier, {
  writeRoles: ['SUPER_USER'],
  listWhere: (req) => {
    const raw = typeof req.query?.type === 'string' ? req.query.type.toUpperCase() : '';
    if (raw === 'ALL') return undefined;
    const types = raw.split(',').map((t: string) => t.trim()).filter((t: string) => PARTNER_TYPES.includes(t));
    return { partnerType: { in: types.length ? types : ['CARRIER'] } };
  },
});
