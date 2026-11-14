// Destination: apps/web/src/pages/accounting/CommissionReconciliation.tsx
import { useEffect, useState } from 'react';
import { Select, Collapse, Button, DatePicker, Table, Tag, Space, Typography, Empty, message, Input, Statistic, Row, Col } from 'antd';
import dayjs from 'dayjs';
import TabularBucketPanel from '../../components/TabularBucketPanel';
import CommissionStatementPanel from '../../components/CommissionStatementPanel';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface Group {
  id: number;
  company: string;
  // 2026-08-31: populated by the API's groups.ts (withLastSyncedAt) - the
  // most recent Election.loadedAt for that group, or null if it has never
  // had an EN sync (e.g. a Marketing-onboarded group with no EN account).
  lastSyncedAt: string | null;
}

interface Product {
  id: number;
  name: string;
}

interface Carrier {
  id: number;
  name: string;
}

interface CommissionPeriod {
  id: number;
  groupId: number;
  periodMonth: string;
  label: string;
  status: string;
}

interface ReconciliationFilter {
  id: number;
  name: string;
  carrierNames: string[];
  productIds: number[];
  groupIds: number[];
}

interface CompareRow {
  carrierName: string;
  productName: string | null;
  censusTotal: number;
  statementTotal: number;
  difference: number;
  status: string;
  onlyOnCensus: boolean;
  onlyOnStatement: boolean;
}

interface CompareResponse {
  censusGrandTotal: number;
  statementGrandTotal: number;
  difference: number;
  results: CompareRow[];
}

// Kept as a small local copy rather than a shared import - same reasoning as
// Groups.tsx/Reconciliation.tsx: no existing shared-utils module for this,
// and one extra new file to place correctly wasn't worth it for four lines
// of logic given how many deploy mixups a new file path has already caused
// tonight. Renders in the browser's own local timezone (toLocaleDateString
// with no explicit timeZone) - side-steps the UTC-vs-local mismatch that
// bit morning_report.ps1's timestamps. Date-only, no time, no "last
// synced:" text - matches the other two pages, and fits inside these
// fixed-width Select boxes.
function labelWithSync(g: Group): string {
  if (!g.lastSyncedAt) return g.company;
  const formatted = new Date(g.lastSyncedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${g.company} (${formatted})`;
}

export default function CommissionReconciliation() {
  // --- Filter / compare state --------------------------------------------
  const [groups, setGroups] = useState<Group[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [savedFilters, setSavedFilters] = useState<ReconciliationFilter[]>([]);

  const [carrierNames, setCarrierNames] = useState<string[]>([]);
  const [productIds, setProductIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResponse | null>(null);

  // --- Manual census fallback state (unchanged from before - still
  // per-group-per-month, for groups the nightly EN sync doesn't cover) -----
  const [censusGroupId, setCensusGroupId] = useState<number | null>(null);
  const [periods, setPeriods] = useState<CommissionPeriod[]>([]);
  const [censusPeriodId, setCensusPeriodId] = useState<number | null>(null);
  const [newPeriodMonth, setNewPeriodMonth] = useState<dayjs.Dayjs | null>(null);
  const [creatingPeriod, setCreatingPeriod] = useState(false);
  // 2026-08-31: same reasoning as Reconciliation.tsx's selectedGroup - the
  // "1. Find the Group" dropdown truncates a long name before its "(Aug 30)"
  // is visible, so surface the full label uncut once a group's picked.
  const censusSelectedGroup = groups.find((g) => g.id === censusGroupId) ?? null;

  useEffect(() => {
    fetch('/api/groups').then((res) => res.json()).then(setGroups);
    fetch('/api/products').then((res) => res.json()).then(setProducts);
    // Carrier options were never fetched before - the "Carrier(s)" field had
    // no options wired up at all (unlike groups/products above), which is
    // why it always looked empty. This still uses mode="tags" below, so a
    // carrier name that isn't in the catalog yet can still be typed and
    // added directly - carrierName is free text on CensusEntry/
    // CommissionStatementEntry, never a hard FK.
    // CARRIER,TPA: Employee Navigator election and census data names HSA/FSA
    // administrators (WEX, HSA Bank, Surency...) as the carrier, so those
    // TPA rows must stay pickable in this filter.
    fetch('/api/carriers?type=CARRIER,TPA').then((res) => res.json()).then(setCarriers);
    loadFilters();
  }, []);

  const loadFilters = async () => {
    const res = await fetch('/api/reconciliation/filters');
    setSavedFilters(await res.json());
  };

  const loadTemplate = (id: number) => {
    const f = savedFilters.find((sf) => sf.id === id);
    if (!f) return;
    setCarrierNames(f.carrierNames);
    setProductIds(f.productIds);
    setGroupIds(f.groupIds);
    setTemplateName(f.name);
    message.info(`Loaded "${f.name}" - every field is still editable, nothing is locked`);
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) {
      message.error('Give the template a name first');
      return;
    }
    setSavingTemplate(true);
    try {
      const res = await fetch('/api/reconciliation/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: templateName.trim(), carrierNames, productIds, groupIds }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save template');
      message.success(`Saved "${json.name}"`);
      await loadFilters();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const runCompare = async () => {
    if (!dateRange || !dateRange[0] || !dateRange[1]) {
      message.error('Pick a date range first');
      return;
    }
    setComparing(true);
    setCompareResult(null);
    try {
      const res = await fetch('/api/reconciliation/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrierNames,
          productIds,
          groupIds,
          dateStart: dateRange[0].format('YYYY-MM-DD'),
          dateEnd: dateRange[1].format('YYYY-MM-DD'),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to run comparison');
      setCompareResult(json);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setComparing(false);
    }
  };

  const compareColumns = [
    { title: 'Carrier', dataIndex: 'carrierName', key: 'carrierName' },
    { title: 'Product', dataIndex: 'productName', key: 'productName', render: (v: string | null) => v ?? 'Unassigned' },
    { title: 'Census Total', dataIndex: 'censusTotal', key: 'censusTotal', render: (v: number) => `$${v.toFixed(2)}` },
    { title: 'Statement Total', dataIndex: 'statementTotal', key: 'statementTotal', render: (v: number) => `$${v.toFixed(2)}` },
    { title: 'Difference', dataIndex: 'difference', key: 'difference', render: (v: number) => `$${v.toFixed(2)}` },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, record: CompareRow) =>
        record.status === 'matched' ? (
          <Tag color="green">Matched</Tag>
        ) : (
          <Tag color="red">
            Needs examination
            {record.onlyOnCensus ? ' - only on census' : ''}
            {record.onlyOnStatement ? ' - only on statement' : ''}
          </Tag>
        ),
    },
  ];

  // --- Manual census fallback ----------------------------------------------
  const loadPeriods = async (gid: number) => {
    const res = await fetch(`/api/groups/${gid}/commission-periods`);
    setPeriods(await res.json());
  };

  useEffect(() => {
    if (censusGroupId === null) {
      setPeriods([]);
      setCensusPeriodId(null);
      return;
    }
    setCensusPeriodId(null);
    loadPeriods(censusGroupId);
  }, [censusGroupId]);

  const createPeriod = async () => {
    if (censusGroupId === null || !newPeriodMonth) return;
    setCreatingPeriod(true);
    try {
      const res = await fetch(`/api/groups/${censusGroupId}/commission-periods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodMonth: newPeriodMonth.format('YYYY-MM-DD') }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to create period');
      message.success(`Created ${json.label}`);
      setNewPeriodMonth(null);
      await loadPeriods(censusGroupId);
      setCensusPeriodId(json.id);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreatingPeriod(false);
    }
  };

  return (
    <div>
      <Title level={4}>Commission Statements</Title>
      <Text type="secondary">
        Upload carrier commission statements here - no need to pick a company first. Census data for EN-covered
        groups is already flowing in automatically overnight; use the fallback section at the bottom only for groups
        that aren&apos;t covered yet.
      </Text>
      <div style={{ marginTop: 12 }}>
        <CommissionStatementPanel />
      </div>

      <Title level={4} style={{ marginTop: 32 }}>
        Compare
      </Title>
      <Text type="secondary">
        Build whatever slice matches how this carrier actually reported - carriers, products, and companies are all
        optional (blank means &quot;all&quot;). Loading a saved template just pre-fills these fields; nothing is
        locked.
      </Text>
      <div style={{ marginTop: 12 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 240 }}
            placeholder="Load a saved template"
            allowClear
            options={savedFilters.map((f) => ({ value: f.id, label: f.name }))}
            onChange={(value) => (value ? loadTemplate(value) : undefined)}
          />
          <Input
            style={{ width: 200 }}
            placeholder="Template name"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
          />
          <Button onClick={saveTemplate} loading={savingTemplate}>
            Save as Template
          </Button>
        </Space>

        <Space wrap style={{ marginBottom: 12 }} size="middle">
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 4 }}>Carrier(s) - type to add</div>
            <Select
              mode="tags"
              style={{ width: 240 }}
              placeholder="All carriers"
              value={carrierNames}
              onChange={setCarrierNames}
              tokenSeparators={[',']}
              options={[...carriers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.name, label: c.name }))}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 4 }}>Product(s)</div>
            <Select
              mode="multiple"
              style={{ width: 240 }}
              placeholder="All products"
              value={productIds}
              onChange={setProductIds}
              options={[...products].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 4 }}>Company(ies)</div>
            <Select
              mode="multiple"
              showSearch
              style={{ width: 280 }}
              placeholder="All companies"
              value={groupIds}
              onChange={setGroupIds}
              options={groups.map((g) => ({ value: g.id, label: labelWithSync(g) }))}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginBottom: 4 }}>Date range</div>
            <RangePicker value={dateRange} onChange={setDateRange} />
          </div>
        </Space>

        <div>
          <Button type="primary" onClick={runCompare} loading={comparing}>
            Run Comparison
          </Button>
        </div>

        {compareResult && (
          <div style={{ marginTop: 16 }}>
            <Row gutter={24} style={{ marginBottom: 12 }}>
              <Col>
                <Statistic title="Census Total" value={compareResult.censusGrandTotal} prefix="$" precision={2} />
              </Col>
              <Col>
                <Statistic title="Statement Total" value={compareResult.statementGrandTotal} prefix="$" precision={2} />
              </Col>
              <Col>
                <Statistic
                  title="Difference"
                  value={compareResult.difference}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: compareResult.difference === 0 ? '#3f8600' : '#cf1322' }}
                />
              </Col>
            </Row>
            <Table
              rowKey={(r) => `${r.carrierName}-${r.productName}`}
              size="small"
              pagination={false}
              columns={compareColumns}
              dataSource={compareResult.results}
              locale={{ emptyText: <Empty description="No data on either side for this filter" /> }}
            />
          </div>
        )}
      </div>

      <Collapse
        style={{ marginTop: 32 }}
        items={[
          {
            key: 'manual-census',
            label: 'Manual Census Upload (fallback for groups not covered by the nightly sync)',
            children: (
              <div>
                <Title level={5}>1. Find the Group</Title>
                <Select
                  showSearch
                  style={{ width: 360 }}
                  placeholder="Select a group"
                  value={censusGroupId ?? undefined}
                  onChange={(value) => setCensusGroupId(value)}
                  options={groups.map((g) => ({ value: g.id, label: labelWithSync(g) }))}
                  filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                />

                {censusGroupId !== null && (
                  <>
                    <Title level={5} style={{ marginTop: 24 }}>
                      2. Commission Period{censusSelectedGroup ? ` - ${labelWithSync(censusSelectedGroup)}` : ''}
                    </Title>
                    <Space>
                      <Select
                        style={{ width: 240 }}
                        placeholder="Select a period"
                        value={censusPeriodId ?? undefined}
                        onChange={(value) => setCensusPeriodId(value)}
                        options={periods.map((p) => ({ value: p.id, label: p.label }))}
                      />
                      <DatePicker picker="month" value={newPeriodMonth} onChange={setNewPeriodMonth} placeholder="New period" />
                      <Button onClick={createPeriod} loading={creatingPeriod} disabled={!newPeriodMonth}>
                        Create Period
                      </Button>
                    </Space>
                  </>
                )}

                {censusPeriodId !== null && (
                  <div style={{ marginTop: 24 }}>
                    <TabularBucketPanel periodId={censusPeriodId} kind="census" />
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
