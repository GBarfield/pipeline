// Destination: apps/web/src/components/BenefitsReconciliationPanel.tsx
import { useState } from 'react';
import { Button, Table, Tag, Space, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import * as XLSX from 'xlsx';

const { Text } = Typography;

interface ComparisonField {
  entryValue: number | null;
  electionValue: number | null;
  delta: number | null;
  status: 'matched' | 'mismatch' | 'info_implied_employer_contribution';
  impliedEmployerContribution?: number;
}

interface ReconciliationRow {
  outcome: 'matched' | 'mismatch' | 'carrier_only' | 'en_only';
  employeeName: string | null;
  employeeId: number | null;
  carrierName: string | null;
  productLabel: string | null;
  product: string | null;
  comparisons: Record<string, ComparisonField>;
  possibleMatches?: string[];
}

interface ReconciliationResult {
  groupId: number;
  summary: {
    matched: number;
    mismatch: number;
    carrier_only: number;
    en_only: number;
    possible_product_mismatch_employees: number;
  };
  rows: ReconciliationRow[];
}

function formatCurrency(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function outcomeTag(outcome: ReconciliationRow['outcome']) {
  switch (outcome) {
    case 'matched':
      return <Tag color="green">Matched</Tag>;
    case 'mismatch':
      return <Tag color="red">Mismatch</Tag>;
    case 'carrier_only':
      return <Tag color="orange">Carrier only</Tag>;
    case 'en_only':
      return <Tag color="blue">EN only</Tag>;
  }
}

function fieldCell(c: ComparisonField | undefined) {
  if (!c) return '-';
  if (c.status === 'info_implied_employer_contribution') {
    return (
      <span>
        {formatCurrency(c.entryValue)} vs {formatCurrency(c.electionValue)}{' '}
        <Tag color="blue">implied employer: {formatCurrency(c.impliedEmployerContribution)}</Tag>
      </span>
    );
  }
  return (
    <span>
      {formatCurrency(c.entryValue)} vs {formatCurrency(c.electionValue)}{' '}
      {c.status === 'mismatch' ? <Tag color="red">Δ {formatCurrency(c.delta)}</Tag> : <Tag color="green">exact</Tag>}
    </span>
  );
}

export default function BenefitsReconciliationPanel({ groupId }: { groupId: number | null }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReconciliationResult | null>(null);

    const runComparison = async () => {
    if (!groupId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/benefits-reconciliation`);
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  };

  // Flattens one row into plain values for the spreadsheet - every
  // comparison field becomes its own column rather than the combined
  // "$X vs $Y" cell the table renders, so Excel's own sort/filter acts on
  // a real number instead of formatted text.
  const flattenRow = (r: ReconciliationRow) => {
    const monthly = r.comparisons.monthlyCost;
    const benefit = r.comparisons.benefitAmount;
    const payroll = r.comparisons.coveredPayrollAmount;
        return {
      Outcome: r.outcome,
      Employee: r.employeeName ?? '',
      'Employee ID': r.employeeId ?? '',
      Carrier: r.carrierName ?? '',
      Plan: r.product ?? r.productLabel ?? '',
      'Possibly Same As': r.possibleMatches?.join('; ') ?? '',
      'Monthly Cost (Carrier)': monthly?.entryValue ?? '',
      'Monthly Cost (EN)': monthly?.electionValue ?? '',
      'Monthly Cost Δ': monthly?.status === 'mismatch' ? monthly.delta : '',
      'Implied Employer Contribution':
        monthly?.status === 'info_implied_employer_contribution' ? monthly.impliedEmployerContribution : '',
      'Benefit Amount (Carrier)': benefit?.entryValue ?? '',
      'Benefit Amount (EN)': benefit?.electionValue ?? '',
      'Benefit Amount Δ': benefit?.status === 'mismatch' ? benefit.delta : '',
      'Covered Payroll (Carrier)': payroll?.entryValue ?? '',
      'Covered Payroll (EN)': payroll?.electionValue ?? '',
      'Covered Payroll Δ': payroll?.status === 'mismatch' ? payroll.delta : '',
    };
  };

  const exportToExcel = () => {
    if (!result) return;
    const ws = XLSX.utils.json_to_sheet(result.rows.map(flattenRow));
    ws['!autofilter'] = { ref: ws['!ref']! };
        ws['!cols'] = [
      { wch: 12 }, { wch: 20 }, { wch: 11 }, { wch: 14 }, { wch: 20 }, { wch: 24 },
      { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 20 },
      { wch: 16 }, { wch: 14 }, { wch: 12 },
      { wch: 16 }, { wch: 14 }, { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation');
    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `benefits-reconciliation-group-${groupId}-${dateStamp}.xlsx`);
  };

  if (!groupId) {
    return <Text type="secondary">Select a group above to run a comparison.</Text>;
  }

  const columns: TableColumnsType<ReconciliationRow> = [
    { title: 'Outcome', key: 'outcome', render: (_, r) => outcomeTag(r.outcome) },
    { title: 'Employee', dataIndex: 'employeeName', key: 'employeeName', render: (v) => v ?? '-' },
    { title: 'Carrier', dataIndex: 'carrierName', key: 'carrierName', render: (v) => v ?? '-' },
        { title: 'Plan', key: 'plan', render: (_, r) => r.product ?? r.productLabel ?? '-' },
    {
      title: 'Possibly Same As',
      key: 'possibleMatches',
      render: (_, r) =>
        r.possibleMatches && r.possibleMatches.length > 0 ? (
          <Tag color="purple">{r.possibleMatches.join('; ')}</Tag>
        ) : (
          '-'
        ),
    },
    { title: 'Monthly Cost (Carrier vs EN)', key: 'monthlyCost', render: (_, r) => fieldCell(r.comparisons.monthlyCost) },
    { title: 'Benefit Amount', key: 'benefitAmount', render: (_, r) => fieldCell(r.comparisons.benefitAmount) },
    { title: 'Covered Payroll', key: 'coveredPayrollAmount', render: (_, r) => fieldCell(r.comparisons.coveredPayrollAmount) },
  ];

  return (
    <div>
            <Space style={{ marginBottom: 12 }}>
        <Button type="primary" loading={loading} onClick={runComparison}>
          Run Comparison
        </Button>
        <Button disabled={!result} onClick={exportToExcel}>
          Export to Excel
        </Button>
                {result && (
          <Space>
            <Tag color="green">{result.summary.matched} matched</Tag>
            <Tag color="red">{result.summary.mismatch} mismatch</Tag>
            <Tag color="orange">{result.summary.carrier_only} carrier only</Tag>
            <Tag color="blue">{result.summary.en_only} EN only</Tag>
            {result.summary.possible_product_mismatch_employees > 0 && (
              <Tag color="purple">
                {result.summary.possible_product_mismatch_employees} possible plan-name mismatches
              </Tag>
            )}
          </Space>
        )}
      </Space>

      {result && (
        <Table
          rowKey={(r) => `${r.employeeId ?? 'noemp'}-${r.productLabel ?? 'noplan'}-${r.outcome}`}
          size="small"
          pagination={{ pageSize: 20 }}
          columns={columns}
          dataSource={result.rows}
        />
      )}
    </div>
  );
}