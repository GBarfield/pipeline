// Destination: apps/web/src/pages/benefits-administration/Reconciliation.tsx
import { useEffect, useState } from 'react';
import { Typography, Select, Divider, Card, Space } from 'antd';
import BenefitsDocumentBucketPanel from '../../components/BenefitsDocumentBucketPanel';
import EmployeeNavigatorPanel from '../../components/EmployeeNavigatorPanel';
import BenefitsReconciliationPanel from '../../components/BenefitsReconciliationPanel';

const { Title, Text } = Typography;

interface Group {
  id: number;
  company: string;
  // 2026-08-31: populated by the API's groups.ts (withLastSyncedAt) - the
  // most recent Election.loadedAt for that group, or null if it has never
  // had an EN sync (e.g. a Marketing-onboarded group with no EN account).
  lastSyncedAt: string | null;
}

// Kept as a small local copy rather than a shared import - this app has no
// existing shared-utils module for view-layer formatting, and after two
// file-mixup deploy incidents in one day, one extra new file to place
// correctly wasn't worth it for four lines of logic. If a third place ends
// up needing this, that's the point to factor it out for real.
//
// Renders in the browser's own local timezone (toLocaleDateString with no
// explicit timeZone) - side-steps the UTC-vs-local mismatch that bit
// morning_report.ps1's timestamps.
//
// Date-only, no time, no "last synced:" label - this renders inside a
// fixed-width Select option (260px) and the fuller version was getting cut
// off illegibly. Matches Groups.tsx's labelWithSync for consistency.
function labelWithSync(g: Group): string {
  if (!g.lastSyncedAt) return g.company;
  const formatted = new Date(g.lastSyncedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${g.company} (${formatted})`;
}

interface Carrier {
  id: number;
  name: string;
}

export default function BenefitsAdministrationReconciliation() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [selectedCarrierName, setSelectedCarrierName] = useState<string | null>(null);
  // 2026-08-31: the dropdown itself truncates a long company name before its
  // "(Aug 30)" ever becomes visible - Gregg asked for the full name + date
  // to show somewhere uncut once a group is actually picked. The card title
  // is that spot: reuses the same groups list already fetched for the
  // picker, no extra request needed.
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  useEffect(() => {
    fetch('/api/groups')
      .then((res) => res.json())
      .then((data: Group[]) => setGroups(data));
    fetch('/api/carriers')
      .then((res) => res.json())
      .then((data: Carrier[]) => setCarriers(data));
  }, []);

    return (
    <div>
      <Title level={3}>Benefits Administration Reconciliation</Title>

      <Space style={{ marginBottom: 16 }}>
        <Text type="secondary">Group:</Text>
        <Select
          showSearch
          allowClear
          placeholder="Select a group"
          style={{ width: 260 }}
          value={selectedGroupId ?? undefined}
          onChange={(value) => setSelectedGroupId(value ?? null)}
          options={groups.map((g) => ({ value: g.id, label: labelWithSync(g) }))}
          filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
        />
        <Text type="secondary">Carrier:</Text>
        <Select
          showSearch
          allowClear
          placeholder="(any carrier)"
          style={{ width: 220 }}
          value={selectedCarrierName ?? undefined}
          onChange={(value) => setSelectedCarrierName(value ?? null)}
          options={carriers.map((c) => ({ value: c.name, label: c.name }))}
          filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
        />
      </Space>

            <Card
        title={selectedGroup ? `Carrier Documents - ${labelWithSync(selectedGroup)}` : 'Carrier Documents'}
        style={{ marginBottom: 24 }}
      >
        <BenefitsDocumentBucketPanel groupId={selectedGroupId} carrierName={selectedCarrierName} />
      </Card>

      <Divider />

      <Card
        title={selectedGroup ? `Reconciliation - ${labelWithSync(selectedGroup)}` : 'Reconciliation'}
        style={{ marginBottom: 24 }}
      >
        <BenefitsReconciliationPanel groupId={selectedGroupId} />
      </Card>

      <Divider />

      <Card
        title={
          selectedGroup
            ? `Employee Navigator - ${labelWithSync(selectedGroup)}`
            : 'Employee Navigator'
        }
      >
        {selectedGroupId ? (
          <EmployeeNavigatorPanel groupId={selectedGroupId} />
        ) : (
          <Text type="secondary">Select a group above to view its Employee Navigator data.</Text>
        )}
      </Card>
    </div>
  );
}
