// Destination: apps/api/src/lib/scope.ts
import type { Response } from 'express';
import { prisma } from './prisma.ts';
import type { AuthUser } from '../middleware/auth.ts';

// Sends the 403/404 itself and returns false when access should be denied,
// so a route/middleware can just do: if (!(await canAccessGroup(...))) return;
export async function canAccessGroup(user: AuthUser, groupId: number, res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { brokerId: true } });
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return false;
  }
  if (group.brokerId !== user.brokerId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

export async function canAccessDeal(user: AuthUser, dealId: number, res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { divisionId: true, group: { select: { brokerId: true } } },
  });
  if (!deal) {
    res.status(404).json({ error: 'Deal not found' });
    return false;
  }
  if (deal.group.brokerId !== user.brokerId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  if (user.restrictedDivisionId !== null && deal.divisionId !== user.restrictedDivisionId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

export async function canAccessCommissionPeriod(user: AuthUser, periodId: number, res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  const period = await prisma.commissionPeriod.findUnique({
    where: { id: periodId },
    select: { divisionId: true, group: { select: { brokerId: true } } },
  });
  if (!period) {
    res.status(404).json({ error: 'Commission period not found' });
    return false;
  }
  if (period.group.brokerId !== user.brokerId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  if (user.restrictedDivisionId !== null && period.divisionId !== user.restrictedDivisionId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// Bulk-checks a list of group IDs for the new filter routes (ReconciliationFilter.groupIds
// is an array - a filter can span multiple groups at once). An empty array means "no group
// restriction specified" - the CALLER is responsible for scoping that to the user's own
// groups for a BROKER_USER rather than treating it as "all groups system-wide".
export async function canAccessGroups(user: AuthUser, groupIds: number[], res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  if (groupIds.length === 0) return true;
  const groups = await prisma.group.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, brokerId: true },
  });
  if (groups.length !== groupIds.length) {
    res.status(404).json({ error: 'One or more groups not found' });
    return false;
  }
  if (groups.some((g) => g.brokerId !== user.brokerId)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// CommissionStatementEntry rows can be unassigned (groupId null) between upload and
// manual company-tagging under the v2 filtering design. Unassigned rows are SUPER_USER-only:
// a BROKER_USER has no way to know which broker an untagged company belongs to until
// someone resolves it, so exposing unassigned rows to any BROKER_USER would leak other
// brokers' data. Revisit if that assumption is wrong.
export async function canAccessCommissionStatementEntry(user: AuthUser, entryId: number, res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  const entry = await prisma.commissionStatementEntry.findUnique({
    where: { id: entryId },
    select: { group: { select: { brokerId: true } } },
  });
  if (!entry) {
    res.status(404).json({ error: 'Commission statement entry not found' });
    return false;
  }
  if (!entry.group || entry.group.brokerId !== user.brokerId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// BenefitsDocumentEntry rows can be unassigned (groupId null) between upload
// and manual company-tagging, same as CommissionStatementEntry above -
// unassigned rows are SUPER_USER-only for the identical reason: a
// BROKER_USER has no way to know which broker an untagged company belongs
// to until someone resolves it. Also checks restrictedDivisionId, which
// canAccessCommissionStatementEntry does not - unlike CommissionStatementEntry,
// this model is division-stamped from day one (see the schema comment).
export async function canAccessBenefitsDocumentEntry(user: AuthUser, entryId: number, res: Response): Promise<boolean> {
  if (user.role === 'SUPER_USER') return true;
  const entry = await prisma.benefitsDocumentEntry.findUnique({
    where: { id: entryId },
    select: { divisionId: true, group: { select: { brokerId: true } } },
  });
  if (!entry) {
    res.status(404).json({ error: 'Benefits document entry not found' });
    return false;
  }
  if (!entry.group || entry.group.brokerId !== user.brokerId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  if (user.restrictedDivisionId !== null && entry.divisionId !== user.restrictedDivisionId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}