// Destination: apps/web/src/pages/databases/Groups.tsx
import { useState } from 'react';
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';
import { groupWorkspacePanels } from '../../components/GroupWorkspace';

const fields: FieldConfig[] = [
  { name: 'company', label: 'Company', type: 'text', required: true },
  { name: 'contactFirstName', label: 'Contact First Name', type: 'text' },
  { name: 'contactLastName', label: 'Contact Last Name', type: 'text' },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'city', label: 'City', type: 'text' },
  { name: 'state', label: 'State', type: 'text' },
  { name: 'zip', label: 'ZIP', type: 'text' },
  { name: 'phone', label: 'Phone', type: 'text' },
  { name: 'email', label: 'Email', type: 'text' },
  { name: 'effectiveDate', label: 'Effective Date', type: 'date' },
  { name: 'shortCode', label: 'Short Code', type: 'text' },
  { name: 'industry', label: 'Industry', type: 'text' },
  { name: 'sicCode', label: 'SIC Code', type: 'text' },
  { name: 'signatureType', label: 'Signature Type', type: 'text' },
  {
    name: 'brokerId',
    label: 'Broker',
    type: 'relation',
    relationApi: '/api/brokers',
    relationLabel: (r) => `${r.firstName} ${r.lastName}`,
  },
  {
    name: 'carrierId',
    label: 'Carrier',
    type: 'relation',
    relationApi: '/api/carriers',
    relationLabelKey: 'name',
  },
  { name: 'isIHQ', label: 'IHQ', type: 'switch' },
  { name: 'hasPortal', label: 'Has Portal', type: 'switch' },
  { name: 'archived', label: 'Archived', type: 'switch' },
];

// 2026-08-31: appends "(Aug 30)" using the lastSyncedAt field the API now
// computes (see groups.ts's withLastSyncedAt) from the newest Election row
// for that group. Formatted with toLocaleDateString() and no explicit
// timeZone - that renders in whatever local timezone the browser itself is
// set to, so this sidesteps the UTC/local mismatch that bit
// morning_report.ts's timestamps (Date.toISOString() always being UTC) -
// here the conversion happens for free on the client. A group with no EN
// data at all (lastSyncedAt is null - e.g. Marketing-onboarded, no EN
// account) shows no parenthetical rather than a misleading blank/zero date.
//
// Date-only, no time, no "last synced:" label - this renders inside a
// fixed-width Select option and the fuller "(last synced: Aug 30, 8:47 AM)"
// was getting truncated illegibly. If more precision is ever needed, it
// belongs in a tooltip on the option, not stuffed into the label text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function labelWithSync(r: any): string {
  if (!r.lastSyncedAt) return r.company;
  const formatted = new Date(r.lastSyncedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${r.company} (${formatted})`;
}

export default function Groups() {
  const [selectedDealId, setSelectedDealId] = useState<number | null>(null);
  const [dealsForGroupId, setDealsForGroupId] = useState<number | null>(null);

  return (
    <MaintenancePage
      title="Groups"
      apiBase="/api/groups"
      fields={fields}
      labelFor={labelWithSync}
      accordion={{ selectLabel: '1. Find the Group', formLabel: '2. Group Demographics' }}
      extraPanels={(record) => {
        if (dealsForGroupId !== record.id) {
          // A different group was selected - reset which deal is active.
          setDealsForGroupId(record.id);
          setSelectedDealId(null);
        }
        return groupWorkspacePanels(record, selectedDealId, setSelectedDealId);
      }}
    />
  );
}
