// Destination: apps/web/src/components/BenefitsDocumentBucketPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Upload, Table, Button, message, Alert, Select, Space, Tag, Typography } from 'antd';
import { InboxOutlined, LoadingOutlined } from '@ant-design/icons';
import type { UploadProps, TableColumnsType } from 'antd';
import { useAuth } from '../context/AuthContext';

const { Dragger } = Upload;
const { Text } = Typography;

interface Product {
  id: number;
  name: string;
}

interface Group {
  id: number;
  company: string;
}

interface BenefitsDocumentEntry {
  id: number;
  groupId: number | null;
  group: Group | null;
  companyNameRaw: string | null;
  sourceFile: string;
  employeeName: string | null;
  carrierName: string;
  carrierNameConfirmed: boolean;
  productId: number | null;
  productLabel: string | null;
  product: Product | null;
  planName: string | null;
  coverageTier: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  status: string | null;
  employeeMonthlyCost: string | null;
  employeePerPayCost: string | null;
  employerMonthlyCost: string | null;
  benefitAmount: string | null;
  coveredPayrollAmount: string | null;
  createdAt: string;
}

interface PendingMapping {
  mapping: Record<string, string>;
  mappingSource: string;
  preview: Record<string, unknown>[];
}

const TARGET_FIELDS = [
  { value: 'employeeName', label: 'Employee Name' },
  { value: 'carrierName', label: 'Carrier' },
  { value: 'productLabel', label: 'Product' },
  { value: 'planName', label: 'Plan Name' },
  { value: 'coverageTier', label: 'Coverage Tier' },
  { value: 'effectiveDate', label: 'Effective Date' },
  { value: 'terminationDate', label: 'Termination Date' },
  { value: 'status', label: 'Status' },
  { value: 'companyName', label: 'Company / Employer' },
  { value: 'employeeMonthlyCost', label: 'Employee Monthly Cost' },
  { value: 'employeePerPayCost', label: 'Employee Per-Pay Cost' },
  { value: 'employerMonthlyCost', label: 'Employer Monthly Cost' },
  { value: 'benefitAmount', label: 'Benefit Amount' },
  { value: 'coveredPayrollAmount', label: 'Covered Payroll Amount' },
  { value: 'employeeSsnRaw', label: 'Employee SSN' },
  { value: 'unmapped', label: '(Ignore this column)' },
];

function formatDate(v: string | null): string {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString();
}

function formatCurrency(v: string | null): string {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (Number.isNaN(n)) return '-';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

interface BenefitsDocumentBucketPanelProps {
  groupId: number | null;
  carrierName: string | null;
}

export default function BenefitsDocumentBucketPanel({ groupId, carrierName }: BenefitsDocumentBucketPanelProps) {
  const { user } = useAuth();
  const isSuperUser = user?.role === 'SUPER_USER';

  const [entries, setEntries] = useState<BenefitsDocumentEntry[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingMapping | null>(null);
  const pendingFileRef = useRef<File | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    fetch('/api/groups')
      .then((res) => res.json())
      .then(setGroups);
  }, []);

    const loadEntries = async () => {
    if (!groupId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ groupId: String(groupId) });
      if (carrierName) params.set('carrierName', carrierName);
      const res = await fetch(`/api/benefits-documents?${params}`, { cache: 'no-store' });
      setEntries(await res.json());
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  // Blank slate by design: nothing loads until a group is picked above, so
  // this never shows leftover rows from a different group's testing.
  useEffect(() => {
    loadEntries();
  }, [groupId, carrierName]);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.xlsx,.csv,.pdf',
    showUploadList: false,
        customRequest: async ({ file, onSuccess, onError }) => {
      if (uploading) return;
      if (!groupId) {
        message.warning('Pick a group above before uploading.');
        onError?.(new Error('No group selected'));
        return;
      }
      setUploading(true);
      setPending(null);

      const formData = new FormData();
      formData.append('file', file as File);
      formData.append('groupId', String(groupId));
      if (carrierName) formData.append('carrierName', carrierName);

      try {
        const res = await fetch('/api/benefits-documents/upload', { method: 'POST', body: formData });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to process the file');

        if (json.needsReview) {
          pendingFileRef.current = file as File;
          setPending({ mapping: json.mapping, mappingSource: json.mappingSource, preview: json.preview });
          message.warning('Some columns need review before this can be imported - check the mapping below.');
        } else {
          const unassignedNote = json.unassignedCount > 0 ? ` (${json.unassignedCount} unassigned - tag the company below)` : '';
          message.success(`${json.entries.length} row(s) imported${unassignedNote}`);
          await loadEntries();
        }
        onSuccess?.(json);
      } catch (err) {
        message.error((err as Error).message);
        onError?.(err as Error);
      } finally {
        if (isMountedRef.current) setUploading(false);
      }
    },
  };

  const updateMapping = (sourceColumn: string, targetField: string) => {
    setPending((prev) => (prev ? { ...prev, mapping: { ...prev.mapping, [sourceColumn]: targetField } } : prev));
  };

    const confirmMapping = async () => {
    if (!pending || !pendingFileRef.current || !groupId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', pendingFileRef.current);
      formData.append('mapping', JSON.stringify(pending.mapping));
      formData.append('groupId', String(groupId));
      if (carrierName) formData.append('carrierName', carrierName);

      const res = await fetch('/api/benefits-documents/upload/confirm', { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to import');

      const unassignedNote = json.unassignedCount > 0 ? ` (${json.unassignedCount} unassigned - tag the company below)` : '';
      message.success(`${json.entries.length} row(s) imported${unassignedNote}`);
      setPending(null);
      pendingFileRef.current = null;
      await loadEntries();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      if (isMountedRef.current) setUploading(false);
    }
  };

  const assignGroup = async (entryId: number, groupId: number) => {
    try {
      const res = await fetch(`/api/benefits-documents/${entryId}/assign-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to assign company');
      message.success(`Tagged to ${json.group.company}`);
      await loadEntries();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns: TableColumnsType<BenefitsDocumentEntry> = [
    {
      title: 'Company',
      key: 'company',
      render: (_, record) =>
        record.group ? (
          record.group.company
        ) : isSuperUser ? (
          <Space>
            <Tag color="orange">Unassigned{record.companyNameRaw ? ` (${record.companyNameRaw})` : ''}</Tag>
            <Select
              showSearch
              size="small"
              style={{ width: 200 }}
              placeholder="Tag company"
              options={groups.map((g) => ({ value: g.id, label: g.company }))}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
              onChange={(value) => assignGroup(record.id, value)}
            />
          </Space>
        ) : (
          <Tag color="orange">Unassigned</Tag>
        ),
    },
    { title: 'Employee', dataIndex: 'employeeName', key: 'employeeName', render: (v: string | null) => v ?? '-' },
    {
      title: 'Carrier',
      key: 'carrierName',
      render: (_, record) => (
        <Space>
          {record.carrierName}
          {!record.carrierNameConfirmed && <Tag color="orange">Unconfirmed (from filename)</Tag>}
        </Space>
      ),
    },
    {
      title: 'Product',
      key: 'product',
      render: (_, record) =>
        record.product?.name ?? (record.productLabel ? <Tag color="orange">{record.productLabel} (unmatched)</Tag> : '-'),
    },
    { title: 'Plan', dataIndex: 'planName', key: 'planName', render: (v: string | null) => v ?? '-' },
    { title: 'Tier', dataIndex: 'coverageTier', key: 'coverageTier', render: (v: string | null) => v ?? '-' },
    { title: 'Effective', dataIndex: 'effectiveDate', key: 'effectiveDate', render: formatDate },
    { title: 'Termination', dataIndex: 'terminationDate', key: 'terminationDate', render: formatDate },
        { title: 'Status', dataIndex: 'status', key: 'status', render: (v: string | null) => v ?? '-' },
    {
      title: 'Employee Cost',
      key: 'employeeCost',
      render: (_, record) => {
        const monthly = formatCurrency(record.employeeMonthlyCost);
        const perPay = record.employeePerPayCost ? ` (${formatCurrency(record.employeePerPayCost)}/pay)` : '';
        return monthly === '-' ? '-' : `${monthly}${perPay}`;
      },
    },
    { title: 'Employer Cost', dataIndex: 'employerMonthlyCost', key: 'employerMonthlyCost', render: formatCurrency },
    {
      title: 'Benefit / Payroll Amount',
      key: 'benefitOrPayroll',
      render: (_, record) =>
        record.benefitAmount
          ? formatCurrency(record.benefitAmount)
          : record.coveredPayrollAmount
          ? `${formatCurrency(record.coveredPayrollAmount)} (payroll basis)`
          : '-',
    },
  ];

    if (!groupId) {
    return <Text type="secondary">Select a group above to view or upload its carrier documents.</Text>;
  }

  return (
    <div>
      {isSuperUser && (
        <>
          <Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">{uploading ? <LoadingOutlined spin /> : <InboxOutlined />}</p>
            <p className="ant-upload-text">{uploading ? 'Processing...' : 'Drop a carrier eligibility/enrollment document here'}</p>
            <p className="ant-upload-hint" style={{ fontSize: 12 }}>
              .xlsx, .csv, or .pdf - rosters, enrollment confirmations, or invoices.{' '}
              {carrierName
                ? `Carrier will be tagged as "${carrierName}".`
                : "No carrier column? It's matched from the filename; if it can't be matched, tag it manually below."}
            </p>
          </Dragger>

          {pending && (
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              message="Confirm column mapping before importing"
              description={
                <div>
                  <p style={{ marginBottom: 8 }}>
                    A few columns in this file weren&apos;t obvious - check each one below, then confirm.
                  </p>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {Object.entries(pending.mapping).map(([sourceColumn, targetField]) => (
                      <Space key={sourceColumn}>
                        <span style={{ minWidth: 160, display: 'inline-block' }}>{sourceColumn}</span>
                        -&gt;
                        <Select
                          style={{ width: 220 }}
                          value={targetField}
                          options={TARGET_FIELDS}
                          onChange={(value) => updateMapping(sourceColumn, value)}
                        />
                      </Space>
                    ))}
                  </Space>
                  <Button type="primary" style={{ marginTop: 12 }} loading={uploading} onClick={confirmMapping}>
                    Confirm and import
                  </Button>
                </div>
              }
            />
          )}
        </>
      )}

      <Table
        style={{ marginTop: 16 }}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={columns}
        dataSource={entries}
      />
    </div>
  );
}
