// Destination: apps/web/src/components/DealsPanel.tsx
import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, DatePicker, Tag, message } from 'antd';
import type { Dayjs } from 'dayjs';

interface Deal {
  id: number;
  name: string;
  effectiveDate: string | null;
  status: string;
  createdAt: string;
}

interface DealsPanelProps {
  groupId: number;
  selectedDealId: number | null;
  onSelectDeal: (id: number | null) => void;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'blue',
  won: 'green',
  lost: 'red',
  archived: 'default',
};

export default function DealsPanel({ groupId, selectedDealId, onSelectDeal }: DealsPanelProps) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [form] = Form.useForm();

  const loadDeals = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/deals`);
      setDeals(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDeals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const createDeal = async (values: { effectiveDate: Dayjs }) => {
    const res = await fetch(`/api/groups/${groupId}/deals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effectiveDate: values.effectiveDate.toISOString() }),
    });
    if (!res.ok) {
      message.error('Failed to create deal');
      return;
    }
    const deal = await res.json();
    message.success(`${deal.name} created`);
    setNewOpen(false);
    form.resetFields();
    await loadDeals();
    onSelectDeal(deal.id);
  };

  const columns = [
    { title: 'Deal', dataIndex: 'name', key: 'name' },
    {
      title: 'Effective Date',
      dataIndex: 'effectiveDate',
      key: 'effectiveDate',
      render: (v: string | null) => (v ? new Date(v).toLocaleDateString() : '-'),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={STATUS_COLORS[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '',
      key: 'select',
      render: (_: unknown, record: Deal) =>
        selectedDealId === record.id ? (
          <Tag color="processing">Active</Tag>
        ) : (
          <Button size="small" onClick={() => onSelectDeal(record.id)}>
            Work on this deal
          </Button>
        ),
    },
  ];

  return (
    <div>
      <Button type="primary" onClick={() => setNewOpen(true)} style={{ marginBottom: 16 }}>
        + New Deal
      </Button>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={deals}
        pagination={false}
        size="small"
      />

      <Modal
        title="Start a new deal"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={createDeal}>
          <Form.Item
            name="effectiveDate"
            label="Effective date"
            rules={[{ required: true, message: 'Effective date is required' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}