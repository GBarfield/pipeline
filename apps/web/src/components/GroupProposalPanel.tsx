// Destination: apps/web/src/components/GroupProposalPanel.tsx
import { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Select, Tag, Space, message,
  Upload, List, Popconfirm, Drawer, Divider,
} from 'antd';

interface GroupContact { id: number; name: string; title: string | null; email: string; }
interface Product { id: number; name: string; }
interface GroupProposalAttachment { id: number; fileName: string; source: string; createdAt: string; }
interface GroupProposalNote { id: number; note: string; createdAt: string; author?: { name: string } }
interface GroupProposal {
  id: number;
  dealId: number;
  groupContactId: number | null;
  groupContact: GroupContact | null;
  productIds: number[];
  subject: string;
  body: string;
  status: string;
  attachments: GroupProposalAttachment[];
  notes: GroupProposalNote[];
}

// accepted/declined/expired here, not RFQ's responded/declined/expired -
// a Group's reply to a renewal comparison is a real yes/no, not just
// acknowledgment. See conversation note - easy 3-string swap if you'd
// rather match RFQ's wording exactly.
const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  sent: 'blue',
  accepted: 'green',
  declined: 'red',
  expired: 'orange',
};

export default function GroupProposalPanel({ dealId, groupId }: { dealId: number; groupId: number }) {
  const [proposals, setProposals] = useState<GroupProposal[]>([]);
  const [contacts, setContacts] = useState<GroupContact[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [form] = Form.useForm();

  const [activeId, setActiveId] = useState<number | null>(null);
  const active = proposals.find((p) => p.id === activeId) || null;
  const [noteText, setNoteText] = useState('');
  const [pickedContactId, setPickedContactId] = useState<number | undefined>();

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals`);
      setProposals(await res.json());
    } catch {
      message.error('Could not load proposals');
    } finally {
      setLoading(false);
    }
  };

  // Unlike RfqPanel's per-carrier dynamic contact reload, there's only one
  // Group in this whole panel's lifetime (it's determined by the Deal), so
  // contacts load once here and get reused in both the New Proposal modal
  // and the Manage drawer - no separate "drawerContacts" state needed.
  const loadContacts = async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}/contacts`);
      setContacts(await res.json());
    } catch {
      setContacts([]);
    }
  };

  useEffect(() => {
    load();
    loadContacts();
    fetch('/api/benefit-lines').then((r) => r.json()).then(setProducts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, groupId]);

  const openNew = () => {
    form.resetFields();
    setNewOpen(true);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createProposal = async (values: any) => {
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Failed to create proposal');
      const proposal = await res.json();
      message.success('Proposal created');
      setNewOpen(false);
      await load();
      setActiveId(proposal.id);
    } catch {
      message.error('Failed to create proposal');
    }
  };

  const uploadAttachment = async (file: File) => {
    if (!active) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}/attachments`, {
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

  // One-click alternative to a manual upload: pulls the Deal's current
  // comparison workbook straight in via the backend's attach-comparison
  // route, no file picker needed.
  const attachComparison = async () => {
    if (!active) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}/attach-comparison`, {
        method: 'POST',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to attach comparison');
      message.success('Comparison spreadsheet attached');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const sendProposal = async (sendWithoutAttachment: boolean) => {
    if (!active) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sendWithoutAttachment }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Send failed');
      message.success('Proposal sent');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const setStatus = async (status: string) => {
    if (!active) return;
    try {
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}`, {
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
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupContactId: pickedContactId }),
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
      const res = await fetch(`/api/deals/${dealId}/proposals/${active.id}/notes`, {
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
    { title: 'Subject', dataIndex: 'subject', key: 'subject' },
    {
      title: 'Contact',
      key: 'contact',
      render: (_: unknown, p: GroupProposal) => p.groupContact?.name ?? <span style={{ color: '#999' }}>none</span>,
    },
    {
      title: 'Products',
      key: 'products',
      render: (_: unknown, p: GroupProposal) => p.productIds.map(productName).join(', ') || 'all',
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
      render: (_: unknown, p: GroupProposal) => (
        <Button size="small" onClick={() => setActiveId(p.id)}>
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Button type="primary" onClick={openNew} style={{ marginBottom: 16 }}>
        + New Proposal
      </Button>

      <Table rowKey="id" loading={loading} columns={columns} dataSource={proposals} pagination={false} size="small" />

      <Modal title="New Group Proposal" open={newOpen} onCancel={() => setNewOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={createProposal}>
          <Form.Item name="groupContactId" label="Contact (optional - can set later)">
            <Select
              placeholder="Select contact"
              allowClear
              options={contacts.map((c) => ({ value: c.id, label: `${c.name}${c.title ? ` (${c.title})` : ''}` }))}
            />
          </Form.Item>
          <Form.Item name="productIds" label="Products (optional - leave blank to cover everything in the comparison)">
            <Select
              mode="multiple"
              placeholder="Which products does this proposal cover?"
              options={products.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Form.Item>
          <Form.Item name="subject" label="Subject" rules={[{ required: true }]} initialValue="Your Renewal Comparison">
            <Input />
          </Form.Item>
          <Form.Item
            name="body"
            label="Message"
            rules={[{ required: true }]}
            initialValue={`Hello,\n\nAttached is your renewal comparison, showing your current coverage alongside the proposals we received. Please review and let us know if you have any questions.\n\nThank you.`}
          >
            <Input.TextArea rows={6} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={active ? `Proposal - ${active.subject}` : ''} open={!!active} onClose={() => setActiveId(null)} width={480}>
        {active && (
          <>
            <p>
              <strong>Contact:</strong>{' '}
              {active.groupContact ? (
                `${active.groupContact.name} <${active.groupContact.email}>`
              ) : (
                <Space>
                  <Select
                    style={{ width: 220 }}
                    placeholder="Pick a contact"
                    value={pickedContactId}
                    onChange={setPickedContactId}
                    options={contacts.map((c) => ({ value: c.id, label: c.name }))}
                  />
                  <Button size="small" onClick={attachContact}>Set</Button>
                </Space>
              )}
            </p>
            <p><strong>Products:</strong> {active.productIds.map(productName).join(', ') || 'all (none specified)'}</p>
            <p><strong>Subject:</strong> {active.subject}</p>
            <p style={{ whiteSpace: 'pre-wrap' }}><strong>Message:</strong> {active.body}</p>
            <p><strong>Status:</strong> <Tag color={STATUS_COLORS[active.status] || 'default'}>{active.status}</Tag></p>

            <Divider />
            <h4>Attachments</h4>
            <List
              size="small"
              dataSource={active.attachments}
              locale={{ emptyText: 'No attachments yet' }}
              renderItem={(a) => (
                <List.Item key={a.id}>
                  {a.fileName}
                  {a.source === 'comparison' && <Tag style={{ marginLeft: 8 }}>comparison</Tag>}
                </List.Item>
              )}
            />
            <Space>
              <Upload showUploadList={false} beforeUpload={(file) => { uploadAttachment(file); return false; }}>
                <Button>Add Attachment</Button>
              </Upload>
              <Button onClick={attachComparison}>Attach Comparison Spreadsheet</Button>
            </Space>

            {active.status === 'draft' && (
              <>
                <Divider />
                {active.attachments.length > 0 ? (
                  <Button type="primary" onClick={() => sendProposal(false)}>Send Proposal</Button>
                ) : (
                  <Popconfirm title="No attachments yet - send anyway?" okText="Send anyway" onConfirm={() => sendProposal(true)}>
                    <Button type="primary">Send Proposal (no attachment)</Button>
                  </Popconfirm>
                )}
              </>
            )}

            {active.status === 'sent' && (
              <>
                <Divider />
                <Space>
                  <Button onClick={() => setStatus('accepted')}>Mark Accepted</Button>
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
