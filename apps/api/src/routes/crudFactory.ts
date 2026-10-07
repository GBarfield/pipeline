// Destination: apps/api/src/routes/crudFactory.ts
//
// Small generic CRUD router so each entity route file (carriers.ts, brokers.ts,
// products.ts, groups.ts) stays a one-liner. Handles list, get-one, create,
// update, delete against any Prisma model delegate.
//
// Auth/RBAC additions:
//   - Every route requires a logged-in user (requireAuth).
//   - `writeRoles` gates POST/PUT/DELETE to specific roles (e.g. Carriers are
//     read-only for Broker Users, write-only for Super Users).
//   - `scope` returns a where-filter fragment (or undefined for "no extra
//     filter", i.e. a Super User) applied to list/read/update/delete, so a
//     Broker User only ever sees their own rows.
//   - `injectOnCreate` forces fields onto a new record based on the logged-in
//     user (e.g. a Broker User's new Group always gets their own brokerId,
//     no matter what the request body says).
//   - On update, any key returned by `scope()` is stripped from the request
//     body first, so a scoped user can't use PUT to reassign the very field
//     that scopes them (e.g. a Broker User moving a Group to another broker).
//
// 2026-08-31 addition: optional `augment` hook (used first by groups.ts, for
// the "last synced" timestamp shown next to a Group's name). Deliberately
// bulk-shaped - called once with the whole array of records about to be
// returned (length 1 for GET /:id, N for GET /) - rather than a per-record
// hook, so a caller can satisfy it with ONE batched query (e.g. a single
// groupBy) instead of N+1 queries against a 293-row Groups list. Optional
// and opt-in: routes that don't pass it (carriers, brokers, products) are
// completely unaffected. Read-only - never applied on create/update, so an
// augmented field can never accidentally get written back to the DB via a
// PUT that happens to echo the full record back.
//
// 2026-08-31 addition #2: optional `orderBy`. Every list has always sorted
// by `id` (creation order) - fine for most of these entities, but surfaced
// as a real usability problem on Groups once its search dropdown started
// getting used more (creation-order means garbage/newest entries sort
// wherever they happened to be created, not alongside their neighbors
// alphabetically). Opt-in and defaults to the original `{ id: 'asc' }`
// behavior for every route that doesn't pass it, so this changes nothing
// for carriers/brokers/products.

import { Router } from 'express';
import { requireAuth, type AuthUser } from '../middleware/auth.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelDelegate = any; // e.g. prisma.carrier, prisma.broker, ...

export function createCrudRouter(
  delegate: ModelDelegate,
  options: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    include?: any;
    writeRoles?: AuthUser['role'][];
    scope?: (user: AuthUser) => Record<string, unknown> | undefined;
    injectOnCreate?: (user: AuthUser) => Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    augment?: (records: any[]) => Promise<any[]>;
    orderBy?: Record<string, 'asc' | 'desc'>;
  } = {}
) {
  const router = Router();
  const { include, writeRoles, scope, injectOnCreate, augment, orderBy } = options;

  router.use(requireAuth);

  function scopedWhere(user: AuthUser, extra: Record<string, unknown> = {}) {
    return { ...extra, ...(scope ? scope(user) : {}) };
  }

  function assertWriteAllowed(user: AuthUser, res: any): boolean {
    if (writeRoles && !writeRoles.includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return false;
    }
    return true;
  }

  router.get('/', async (req, res) => {
    try {
      let records = await delegate.findMany({
        where: scopedWhere(req.user!),
        include,
        orderBy: orderBy ?? { id: 'asc' },
      });
      if (augment) records = await augment(records);
      res.json(records);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const record = await delegate.findFirst({
        where: scopedWhere(req.user!, { id: Number(req.params.id) }),
        include,
      });
      if (!record) return res.status(404).json({ error: 'Not found' });
      const [augmented] = augment ? await augment([record]) : [record];
      res.json(augmented);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post('/', async (req, res) => {
    if (!assertWriteAllowed(req.user!, res)) return;
    try {
      const data = { ...req.body, ...(injectOnCreate ? injectOnCreate(req.user!) : {}) };
      const created = await delegate.create({ data, include });
      res.status(201).json(created);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put('/:id', async (req, res) => {
    if (!assertWriteAllowed(req.user!, res)) return;
    try {
      const filter = scope ? scope(req.user!) : undefined;
      const existing = await delegate.findFirst({
        where: scopedWhere(req.user!, { id: Number(req.params.id) }),
      });
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const data = { ...req.body };
      if (filter) {
        for (const key of Object.keys(filter)) delete data[key];
      }

      const updated = await delegate.update({
        where: { id: Number(req.params.id) },
        data,
        include,
      });
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete('/:id', async (req, res) => {
    if (!assertWriteAllowed(req.user!, res)) return;
    try {
      const existing = await delegate.findFirst({
        where: scopedWhere(req.user!, { id: Number(req.params.id) }),
      });
      if (!existing) return res.status(404).json({ error: 'Not found' });

      await delegate.delete({ where: { id: Number(req.params.id) } });
      res.status(204).send();
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}