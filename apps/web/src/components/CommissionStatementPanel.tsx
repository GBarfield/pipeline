// Destination: apps/web/src/components/CommissionStatementPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Upload, Table, Button, message, Alert, Select, Space, Tag } from 'antd';
import { InboxOutlined, LoadingOutlined } from '@ant-design/icons';
import type { UploadProps, TableColumnsType } from 'antd';
import { useAuth } from '../context/AuthContext';

const { Dragger } = Upload;

interface Product {
  id: number;
  name: string;
}

interface Group {
  id: number;
  company: string;
}

interface StatementEntry {
  id: number;
  groupId: number | null;
  group: Group | null;
  companyNameRaw: string | null;
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

const TARGET_FIELDS = [
  { value: 'carrierName', label: 'Carrier' },
  { value: 'productLabel', label: 'Product' },
  { value: 'reportedPremium', label: 'Reported Premium' },
  { value: 'commissionAmount', label: 'Commission Amount' },
  { value: 'companyName', label: 'Company / Employer' },
  { value: 'statementPeriodStart', label: 'Period Start Date' },
  { value: 'statementPeriodEnd', label: 'Period End Date' },
  { value: 'unmapped', label: '(Ignore this column)' },
];

export default function CommissionStatementPanel() {
  const { user } = useAuth();
  const isSuperUser = user?.role === 'SUPER_USER';

  const [entries, setEntries] = useState<StatementEntry[]>([]);
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
    setLoading(true);
    try {
      const res = await fetch('/api/commission-statements', { cache: 'no-store' });
      setEntries(await res.json());
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadEntries();
  }, []);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.xlsx,.csv',
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      if (uploading) return;
      setUploading(true);
      setPending(null);

      const formData = new FormData();
      formData.append('file', file as File);

      try {
        const res = await fetch('/api/commission-statements/upload', { method: 'POST', body: formData });
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
    if (!pending || !pendingFileRef.current) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', pendingFileRef.current);
      formData.append('mapping', JSON.stringify(pending.mapping));

      const res = await fetch('/api/commission-statements/upload/confirm', { method: 'POST', body: formData });
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
      const res = await fetch(`/api/commission-statements/${entryId}/assign-group`, {
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

  const columns: TableColumnsType<StatementEntry> = [
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
    { title: 'Carrier', dataIndex: 'carrierName', key: 'carrierName' },
    {
      title: 'Product',
      key: 'product',
      render: (_, record) =>
        record.product?.name ?? (record.productLabel ? <Tag color="orange">{record.productLabel} (unmatched)</Tag> : '-'),
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
    <div>
      {isSuperUser && (
        <>
          <Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">{uploading ? <LoadingOutlined spin /> : <InboxOutlined />}</p>
            <p className="ant-upload-text">{uploading ? 'Processing...' : 'Drop a carrier commission statement here'}</p>
            <p className="ant-upload-hint" style={{ fontSize: 12 }}>
              .xlsx or .csv - no need to pick a company first. Company is matched automatically from the filename;
              if it can't be matched, tag it manually below after upload.
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