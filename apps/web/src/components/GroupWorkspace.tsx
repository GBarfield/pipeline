// Destination: apps/web/src/components/GroupWorkspace.tsx
import { useState } from 'react';
import { Button, Modal, List, Alert, message } from 'antd';
import type { ExtraPanel } from './MaintenancePage';
import DealsPanel from './DealsPanel';
import QuoteBucketPanel from './QuoteBucketPanel';
import RfqPanel from './RfqPanel';
import GroupContactsPanel from './GroupContactsPanel';
import GroupProposalPanel from './GroupProposalPanel';

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  simple_tiered: 'Simple Tiered',
  age_banded: 'Age-Banded',
  flat_rate_per_unit: 'Flat Rate per Unit',
};

interface ComparisonPreviewTab {
  productId: number | null;
  productName: string;
  productType: string;
  columns: unknown[];
}

interface ComparisonPreview {
  dealId: number;
  tabs: ComparisonPreviewTab[];
  reconciliation: unknown[];
}

// Real component (not just a render function) so it can hold its own hook state —
// groupWorkspacePanels() below is a plain function invoked from the parent's render,
// not a component itself, so hooks can't live there directly.
//
// Rendered three times: a scoped preview button in Current Products
// (source="current") and Proposal Worksheets (source="proposal") so each side can be
// sanity-checked on its own, plus one combined build with no source filter in Final
// Proposal, which is the real deliverable — current columns first, then proposal
// columns grouped by carrier, per product tab.
function ComparisonBuilder({
  dealId,
  source,
  buttonLabel,
}: {
  dealId: number;
  source?: 'current' | 'proposal';
  buttonLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<ComparisonPreview | null>(null);

  const scopeLabel =
    source === 'current' ? 'current products' : source === 'proposal' ? 'proposal quotes' : 'quotes';

  const openPreview = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/comparison/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source ? { source } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build comparison preview');
      setPreview(json);
      setOpen(true);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const query = source ? `?source=${source}` : '';
      const res = await fetch(`/api/deals/${dealId}/comparison/export${query}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to export comparison');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : 'comparison.xlsx';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setOpen(false);
      message.success('Comparison workbook downloaded');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const hasTabs = !!preview && preview.tabs.length > 0;

  return (
    <>
      <Button style={{ marginTop: 16 }} type="primary" loading={loading} onClick={openPreview}>
        {buttonLabel}
      </Button>
      <Modal
        title={buttonLabel}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleExport}
        okText="Download Workbook"
        confirmLoading={exporting}
        okButtonProps={{ disabled: !hasTabs }}
      >
        {!hasTabs ? (
          <p>No {scopeLabel} entered for this deal yet.</p>
        ) : (
          <>
            <p>
              This builds one tab per product, using every quote currently on the list (excluding any
              you&apos;ve removed):
            </p>
            <List
              size="small"
              bordered
              dataSource={preview!.tabs}
              renderItem={(tab) => (
                <List.Item>
                  <strong>
                    {tab.productName}
                    {tab.productId === null && (
                      <span style={{ fontWeight: 400, color: '#d48806' }}> (unassigned)</span>
                    )}
                  </strong>
                  <span style={{ marginLeft: 8, color: '#888' }}>
                    ({PRODUCT_TYPE_LABELS[tab.productType] ?? tab.productType}, {tab.columns.length} column
                    {tab.columns.length === 1 ? '' : 's'})
                  </span>
                </List.Item>
              )}
            />
            {preview!.tabs.some((t) => t.productId === null) && (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                message="Some quotes haven't been assigned a Product yet and are grouped by their detected label instead — assign them in Current Products / Proposal Worksheets above for a cleaner tab name."
              />
            )}
            {preview!.reconciliation.length > 0 && (
              <Alert
                style={{ marginTop: 12 }}
                type="info"
                message={`${preview!.reconciliation.length} benefit label(s) couldn't be auto-matched across carriers and will appear as separate rows in the export.`}
              />
            )}
          </>
        )}
      </Modal>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function groupWorkspacePanels(
  record: any,
  selectedDealId: number | null,
  onSelectDeal: (id: number | null) => void
): ExtraPanel[] {
  const groupId = record.id;

  return [
    {
      key: 'deals',
      label: '3. Deals',
      children: (
        <DealsPanel groupId={groupId} selectedDealId={selectedDealId} onSelectDeal={onSelectDeal} />
      ),
    },
    {
      key: 'current',
      label: '4. Current Products',
      children: selectedDealId ? (
        <>
          <QuoteBucketPanel dealId={selectedDealId} source="current" />
          <ComparisonBuilder dealId={selectedDealId} source="current" buttonLabel="Preview Current Products" />
        </>
      ) : (
        <p>Pick or start a deal in the Deals section above first.</p>
      ),
    },
    {
      key: 'proposal',
      label: '5. Proposal Worksheets',
      children: selectedDealId ? (
        <>
          <QuoteBucketPanel dealId={selectedDealId} source="proposal" />
          <ComparisonBuilder dealId={selectedDealId} source="proposal" buttonLabel="Preview Proposal Comparison" />
        </>
      ) : (
        <p>Pick or start a deal in the Deals section above first.</p>
      ),
    },
        {
      key: 'final',
      label: '6. Final Proposal',
      children: selectedDealId ? (
        <ComparisonBuilder dealId={selectedDealId} buttonLabel="Generate Final Proposal" />
      ) : (
        <p>Pick or start a deal in the Deals section above first.</p>
      ),
    },
        {
      key: 'rfqs',
      label: '7. Carrier RFQs',
      children: selectedDealId ? (
        <RfqPanel dealId={selectedDealId} />
      ) : (
        <p>Pick or start a deal in the Deals section above first.</p>
      ),
    },
    {
      key: 'group-contacts',
      label: '8. Group Contacts',
      children: <GroupContactsPanel groupId={groupId} />,
    },
    {
      key: 'group-proposal',
      label: '9. Group Proposal',
      children: selectedDealId ? (
        <GroupProposalPanel dealId={selectedDealId} groupId={groupId} />
      ) : (
        <p>Pick or start a deal in the Deals section above first.</p>
      ),
    },
  ];
}
