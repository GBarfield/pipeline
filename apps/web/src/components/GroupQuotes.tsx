// Destination: apps/web/src/components/GroupQuotes.tsx
import { useCallback, useEffect, useState } from 'react';
import { Card, Table, Upload, Select, Button, Tag, message, Space } from 'antd';
import { InboxOutlined, DownloadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';

const API_ROOT = import.meta.env.VITE_API_URL ?? '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Quote {
  id: number;
  carrierName: string;
  productType: string;
  usedDiscovery: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData: any;
  warnings: string[] | null;
  xlsxPath: string | null;
  createdAt: string;
}

export default function GroupQuotes({ groupId, groupName }: { groupId: number; groupName: string }) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(false);
  const [productType, setProductType] = useState('simple_tiered');
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_ROOT}/api/groups/${groupId}/quotes`);
      setQuotes(await res.json());
    } catch {
      message.error('Could not load quotes');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    load();
  }, [load]);

  const uploadProps: UploadProps = {
    accept: '.pdf',
    multiple: false,
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      setUploading(true);
      try {
        const form = new FormData();
        form.append('file', file as File);
        form.append('product_type', productType);
        const res = await fetch(`${API_ROOT}/api/groups/${groupId}/quotes`, {
          method: 'POST',
          body: form,
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Upload failed');
        message.success(`Extracted ${result.carrierName}'s proposal`);
        onSuccess?.(result);
        load();
      } catch (e) {
        message.error((e as Error).message);
        onError?.(e as Error);
      } finally {
        setUploading(false);
      }
    },
  };

  const columns = [
    { title: 'Carrier', dataIndex: 'carrierName' },
    {
      title: 'Product Type',
      dataIndex: 'productType',
      render: (v: string) => (v === 'age_banded' ? 'Age-Banded' : 'Simple Tiered'),
    },
    {
      title: 'Plans',
      render: (_: unknown, r: Quote) => (r.rawData?.plans || r.rawData?.products || []).length,
    },
    {
      title: 'Source',
      dataIndex: 'usedDiscovery',
      render: (v: boolean) =>
        v ? <Tag color="gold">New carrier</Tag> : <Tag color="green">Known carrier</Tag>,
    },
    {
      title: 'Warnings',
      dataIndex: 'warnings',
      render: (w: string[] | null) =>
        w && w.length ? <Tag color="orange">{w.length} to review</Tag> : <Tag>None</Tag>,
    },
    { title: 'Added', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '',
      render: (_: unknown, r: Quote) =>
        r.xlsxPath ? (
          <Button
            size="small"
            icon={<DownloadOutlined />}
            href={`${API_ROOT}/api/groups/${groupId}/quotes/${r.id}/download`}
          >
            Download
          </Button>
        ) : null,
    },
  ];

  return (
    <Card title={`Carrier Proposals - ${groupName}`} style={{ marginTop: 24 }}>
      <Space style={{ marginBottom: 16 }}>
        <Select
          value={productType}
          onChange={setProductType}
          style={{ width: 260 }}
          options={[
            { value: 'simple_tiered', label: 'Simple Tiered (Medical/Dental/Vision)' },
            { value: 'age_banded', label: 'Age-Banded (Life/AD&D/CI)' },
          ]}
        />
      </Space>
      <Upload.Dragger {...uploadProps} disabled={uploading} style={{ marginBottom: 24 }}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">
          {uploading
            ? 'Extracting... this can take a few minutes for a new carrier'
            : 'Drop a carrier proposal PDF here'}
        </p>
      </Upload.Dragger>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={quotes} pagination={false} />
    </Card>
  );
}