// Destination: apps/web/src/components/TabularBucketPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Upload, Table, Button, message, Alert, Select, Space, Tag } from 'antd';
import { InboxOutlined, LoadingOutlined } from '@ant-design/icons';
import type { UploadProps, TableColumnsType } from 'antd';

const { Dragger } = Upload;

type UploadKind = 'census' | 'commission_statement';

interface Product {
  id: number;
  name: string;
}

interface CensusEntry {
  id: number;
  employeeName: string;
  carrierName: string;
  productId: number | null;
  productLabel: string | null;
  product: Product | null;
  planName: string | null;
  coverageTier: string | null;
  premium: string;
  createdAt: string;
}

interface CommissionEntry {
  id: number;
  carrierName: string;
  productId: number | null;
  productLabel: string | null;
  product: Product | null;
  reportedPremium: string;
  commissionAmount: string | null;
  createdAt: string;
}

interface PendingMapping {
  mapping: Record<string, string>;
  mappingSource: string;
  preview: Record<string, unknown>[];
}

type Entry = CensusEntry | CommissionEntry;

interface TabularBucketPanelProps {
  periodId: number;
  kind: UploadKind;
}

const TARGET_FIELDS: Record<UploadKind, { value: string; label: string }[]> = {
  census: [
    { value: 'employeeName', label: 'Employee Name' },
    { value: 'carrierName', label: 'Carrier' },
    { value: 'productLabel', label: 'Product' },
    { value: 'planName', label: 'Plan Name' },
    { value: 'coverageTier', label: 'Coverage Tier' },
    { value: 'premium', label: 'Premium' },
    { value: 'unmapped', label: '(Ignore this column)' },
  ],
  commission_statement: [
    { value: 'carrierName', label: 'Carrier' },
    { value: 'productLabel', label: 'Product' },
    { value: 'reportedPremium', label: 'Reported Premium' },
    { value: 'commissionAmount', label: 'Commission Amount' },
    { value: 'unmapped', label: '(Ignore this column)' },
  ],
};

function urlsFor(periodId: number, kind: UploadKind) {
  const segment = kind === 'census' ? 'census' : 'commission';
  return {
    entries: `/api/commission-periods/${periodId}/${segment}`,
    upload: `/api/commission-periods/${periodId}/${segment}-upload`,
    confirm: `/api/commission-periods/${periodId}/${segment}-upload/confirm`,
  };
}

export default function TabularBucketPanel({ periodId, kind }: TabularBucketPanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingMapping | null>(null);
  // Held onto so /confirm can re-send the same file alongside the corrected
  // mapping - the Bucket needs the real file again, not just the mapping,
  // since it re-parses and re-applies rather than trusting anything cached
  // server-side between the two calls.
  const pendingFileRef = useRef<File | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const urls = urlsFor(periodId, kind);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const res = await fetch(urls.entries, { cache: 'no-store' });
      setEntries(await res.json());
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadEntries();
    setPending(null);
    pendingFileRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, kind]);

    const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: kind === 'commission_statement' ? '.xlsx,.csv,.pdf' : '.xlsx,.csv',
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      if (uploading) return;
      setUploading(true);
      setPending(null);

      const formData = new FormData();
      formData.append('file', file as File);

      try {
        const res = await fetch(urls.upload, { method: 'POST', body: formData });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to process the file');

        if (json.needsReview) {
          pendingFileRef.current = file as File;
          setPending({ mapping: json.mapping, mappingSource: json.mappingSource, preview: json.preview });
          message.warning('Some columns need review before this can be imported - check the mapping below.');
        } else {
          message.success(`${json.entries.length} row(s) imported`);
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
    if (!pending || !pendingFileRef.current) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', pendingFileRef.current);
      formData.append('mapping', JSON.stringify(pending.mapping));

      const res = await fetch(urls.confirm, { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to import');

      message.success(`${json.entries.length} row(s) imported`);
      setPending(null);
      pendingFileRef.current = null;
      await loadEntries();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      if (isMountedRef.current) setUploading(false);
    }
  };

  const censusColumns: TableColumnsType<Entry> = [
    { title: 'Employee', dataIndex: 'employeeName', key: 'employeeName' },
    { title: 'Carrier', dataIndex: 'carrierName', key: 'carrierName' },
    {
      title: 'Product',
      key: 'product',
      render: (_, record) => {
        const r = record as CensusEntry;
        return r.product?.name ?? (r.productLabel ? <Tag color="orange">{r.productLabel} (unmatched)</Tag> : '-');
      },
    },
    { title: 'Plan', dataIndex: 'planName', key: 'planName' },
    { title: 'Tier', dataIndex: 'coverageTier', key: 'coverageTier' },
    {
      title: 'Premium',
      dataIndex: 'premium',
      key: 'premium',
      render: (v: string) => `$${Number(v).toFixed(2)}`,
    },
  ];

  const commissionColumns: TableColumnsType<Entry> = [
    { title: 'Carrier', dataIndex: 'carrierName', key: 'carrierName' },
    {
      title: 'Product',
      key: 'product',
      render: (_, record) => {
        const r = record as CommissionEntry;
        return r.product?.name ?? (r.productLabel ? <Tag color="orange">{r.productLabel} (unmatched)</Tag> : '-');
      },
    },
    {
      title: 'Reported Premium',
      dataIndex: 'reportedPremium',
      key: 'reportedPremium',
      render: (v: string) => `$${Number(v).toFixed(2)}`,
    },
    {
      title: 'Commission',
      dataIndex: 'commissionAmount',
      key: 'commissionAmount',
      render: (v: string | null) => (v ? `$${Number(v).toFixed(2)}` : '-'),
    },
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <Dragger {...uploadProps} disabled={uploading}>
        <p className="ant-upload-drag-icon">{uploading ? <LoadingOutlined spin /> : <InboxOutlined />}</p>
        <p className="ant-upload-text">
          {uploading
            ? 'Processing...'
            : kind === 'census'
              ? "Drop the group's census export here (who's enrolled in what)"
              : "Drop the carrier's commission statement here"}
        </p>
        <p className="ant-upload-hint" style={{ fontSize: 12 }}>
          {kind === 'commission_statement'
            ? '.xlsx, .csv, or .pdf - columns are matched automatically, whatever the layout.'
            : '.xlsx or .csv - columns are matched automatically, whatever the layout.'}
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
                      options={TARGET_FIELDS[kind]}
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

      <Table
        style={{ marginTop: 16 }}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={false}
        columns={kind === 'census' ? censusColumns : commissionColumns}
        dataSource={entries}
      />
    </div>
  );
}