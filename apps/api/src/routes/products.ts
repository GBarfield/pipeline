// Destination: apps/api/src/routes/products.ts
import { createCrudRouter } from './crudFactory.ts';
import { prisma } from '../lib/prisma.ts';

// This used to point at prisma.carrierProduct - a completely different,
// unrelated catalog (per-carrier product listing: name/productType/
// description/carrierId) that nothing else in the schema references.
// CensusEntry.productId, CommissionStatementEntry.productId, and
// Quote.productId are all FKs into the *Product* model (flat catalog:
// id/name/active - "Medical"/"Dental"/"Vision"), and resolveProductId()
// resolves against that same Product table. Serving CarrierProduct rows
// here meant the Compare screen's Product dropdown either showed nothing
// (if CarrierProduct was empty) or showed IDs that could never match a
// real CensusEntry/CommissionStatementEntry productId even when selected.
export default createCrudRouter(prisma.product, { writeRoles: ['SUPER_USER'] });