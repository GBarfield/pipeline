// Destination: apps/web/src/components/RfqPanel.tsx
import { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, message,
  Upload, List, Popconfirm, Drawer, Divider,
} from 'antd';

interface Carrier { id: number; name: string; }
interface CarrierContact { id: number; name: string; title: string | null; email: string; }
interface Product { id: number; name: string; }
interface RfqAttachment { id: number; fileName: string; source: string; createdAt: string; }
interface RfqNote { id: number; note: string; createdAt: string; author?: { name: string } }
interface Rfq {
  id: number;
  carrierId: number;
  carrier: Carrier;
  carrierContactId: number | null;
  carrierContact: CarrierContact | null;
  productIds: number[];
  subject: string;
  body: string;
  status: string;
  attachments: RfqAttachment[];
  notes: RfqNote[];
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  sent: 'blue',
  responded: 'green',
  declined: 'red',
  expired: 'orange',
};

export default function RfqPanel({ dealId }: { dealId: number }) {
  const [rfqs, setRfqs] = useState<Rfq[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [newContacts, setNewContacts] = useState<CarrierContact[]>([]);
  const [form] = Form.useForm();

  const [activeId, setActiveId] = useState<number | null>(null);
  const active = rfqs.find((r) => r.id === activeId) || null;
  const [noteText, setNoteText] = useState('');
  const [drawerContacts, setDrawerContacts] = useState<CarrierContact[]>([]);
  const [pickedContactId, setPickedContactId] = useState<number | undefined>();

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs`);
      setRfqs(await res.json());
    } catch {
      message.error('Could not load RFQs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    fetch('/api/carriers').then((r) => r.json()).then(setCarriers).catch(() => {});
    fetch('/api/benefit-lines').then((r) => r.json()).then(setProducts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  useEffect(() => {
    if (active && !active.carrierContact) {
      fetch(`/api/carriers/${active.carrierId}/contacts`).then((r) => r.json()).then(setDrawerContacts).catch(() => setDrawerContacts([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.carrierId]);

  const openNew = () => {
    form.resetFields();
    setNewContacts([]);
    setNewOpen(true);
  };

  const onCarrierChange = async (carrierId: number) => {
    form.setFieldValue('carrierContactId', undefined);
    try {
      const res = await fetch(`/api/carriers/${carrierId}/contacts`);
      setNewContacts(await res.json());
    } catch {
      setNewContacts([]);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createRfq = async (values: any) => {
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Failed to create RFQ');
      const rfq = await res.json();
      message.success('RFQ created');
      setNewOpen(false);
      await load();
      setActiveId(rfq.id);
    } catch {
      message.error('Failed to create RFQ');
    }
  };

  const uploadAttachment = async (file: File) => {
    if (!active) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs/${active.id}/attachments`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      message.success('Attachment added');
      await load();
    } catch {
      message.error('Failed to add attachment');
    }
  };

  const sendRfq = async (sendWithoutAttachment: boolean) => {
    if (!active) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs/${active.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendWithoutAttachment }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Send failed');
      message.success('RFQ sent');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const setStatus = async (status: string) => {
    if (!active) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs/${active.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      message.success('Status updated');
      await load();
    } catch {
      message.error('Failed to update status');
    }
  };

  const attachContact = async () => {
    if (!active || !pickedContactId) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs/${active.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrierContactId: pickedContactId }),
      });
      if (!res.ok) throw new Error('Failed to set contact');
      message.success('Contact set');
      await load();
    } catch {
      message.error('Failed to set contact');
    }
  };

  const addNote = async () => {
    if (!active || !noteText.trim()) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/rfqs/${active.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteText.trim() }),
      });
      if (!res.ok) throw new Error('Failed to add note');
      setNoteText('');
      await load();
    } catch {
      message.error('Failed to add note');
    }
  };

  const productName = (id: number) => products.find((p) => p.id === id)?.name ?? `#${id}`;

  const columns = [
    { title: 'Carrier', dataIndex: ['carrier', 'name'], key: 'carrier' },
    {
      title: 'Contact',
      key: 'contact',
      render: (_: unknown, r: Rfq) => r.carrierContact?.name ?? <span style={{ color: '#999' }}>none</span>,
    },
    {
      title: 'Products',
      key: 'products',
      render: (_: unknown, r: Rfq) => r.productIds.map(productName).join(', ') || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => <Tag color={STATUS_COLORS[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, r: Rfq) => (
        <Button size="small" onClick={() => setActiveId(r.id)}>
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Button type="primary" onClick={openNew} style={{ marginBottom: 16 }}>
        + New RFQ
      </Button>

      <Table rowKey="id" loading={loading} columns={columns} dataSource={rfqs} pagination={false} size="small" />

      <Modal title="New RFQ" open={newOpen} onCancel={() => setNewOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={createRfq}>
          <Form.Item name="carrierId" label="Carrier" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder="Select carrier"
              onChange={onCarrierChange}
              filterOption={(input, option) => (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
              options={carriers.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item name="carrierContactId" label="Contact (optional - can set later)">
            <Select
              placeholder="Select contact"
              allowClear
              options={newContacts.map((c) => ({ value: c.id, label: `${c.name}${c.title ? ` (${c.title})` : ''}` }))}
            />
          </Form.Item>
                    <Form.Item name="productIds" label="Products" rules={[{ required: true, message: 'Select at least one product' }]}>
            <Select
              mode="multiple"
              placeholder="Which products do you want bid on?"
              options={products.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Form.Item>
          <Form.Item name="subject" label="Subject" rules={[{ required: true }]} initialValue="Request for Quote">
            <Input />
          </Form.Item>
          <Form.Item
            name="body"
            label="Message"
            rules={[{ required: true }]}
            initialValue={`Hello,\n\nWe'd like to request a quote for the products listed. Please see the attached for details.\n\nThank you.`}
          >
            <Input.TextArea rows={6} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={active ? `RFQ - ${active.carrier.name}` : ''} open={!!active} onClose={() => setActiveId(null)} width={480}>
        {active && (
          <>
            <p>
              <strong>Contact:</strong>{' '}
              {active.carrierContact ? (
                `${active.carrierContact.name} <${active.carrierContact.email}>`
              ) : (
                <Space>
                  <Select
                    style={{ width: 220 }}
                    placeholder="Pick a contact"
                    value={pickedContactId}
                    onChange={setPickedContactId}
                    options={drawerContacts.map((c) => ({ value: c.id, label: c.name }))}
                  />
                  <Button size="small" onClick={attachContact}>Set</Button>
                </Space>
              )}
            </p>
            <p><strong>Products:</strong> {active.productIds.map(productName).join(', ') || '-'}</p>
            <p><strong>Subject:</strong> {active.subject}</p>
            <p style={{ whiteSpace: 'pre-wrap' }}><strong>Message:</strong> {active.body}</p>
            <p><strong>Status:</strong> <Tag color={STATUS_COLORS[active.status] || 'default'}>{active.status}</Tag></p>

            <Divider />
            <h4>Attachments</h4>
            <List
              size="small"
              dataSource={active.attachments}
              locale={{ emptyText: 'No attachments yet' }}
              renderItem={(a) => <List.Item key={a.id}>{a.fileName}</List.Item>}
            />
            <Upload showUploadList={false} beforeUpload={(file) => { uploadAttachment(file); return false; }}>
              <Button>Add Attachment</Button>
            </Upload>

            {active.status === 'draft' && (
              <>
                <Divider />
                {active.attachments.length > 0 ? (
                  <Button type="primary" onClick={() => sendRfq(false)}>Send RFQ</Button>
                ) : (
                  <Popconfirm title="No attachments yet - send anyway?" okText="Send anyway" onConfirm={() => sendRfq(true)}>
                    <Button type="primary">Send RFQ (no attachment)</Button>
                  </Popconfirm>
                )}
              </>
            )}

            {active.status === 'sent' && (
              <>
                <Divider />
                <Space>
                  <Button onClick={() => setStatus('responded')}>Mark Responded</Button>
                  <Button onClick={() => setStatus('declined')}>Mark Declined</Button>
                  <Button onClick={() => setStatus('expired')}>Mark Expired</Button>
                </Space>
              </>
            )}

            <Divider />
            <h4>Notes</h4>
            <List
              size="small"
              dataSource={active.notes}
              locale={{ emptyText: 'No notes yet' }}
              renderItem={(n) => (
                <List.Item key={n.id}>
                  <div>
                    <div>{n.note}</div>
                    <div style={{ fontSize: 12, color: '#999' }}>
                      {n.author?.name ?? 'Unknown'} - {new Date(n.createdAt).toLocaleString()}
                    </div>
                  </div>
                </List.Item>
              )}
            />
            <Input.TextArea rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note..." />
            <Button style={{ marginTop: 8 }} onClick={addNote}>Add Note</Button>
          </>
        )}
      </Drawer>
    </div>
  );
}