// Destination: apps/web/src/pages/benefits-administration/CarrierCommunication.tsx
//
// Carrier Communication (Benefits Administration menu only). Send an email
// to one, several or all contacts on file for a carrier or TPA, free-form or
// from a reusable canned message, optionally about a specific group.
// Backend: apps/api/src/routes/carrierCommunication.ts.
//
// Tabs:
//   Send Message    - the form, with a live preview for the first recipient
//   Sent Messages   - history: who it went to and whether each email was sent
//   Canned Messages - create/edit/delete reusable messages
//
// Placeholders ({{contact_name}} etc.) are filled in per recipient on the
// server. renderPlaceholders below is a copy of apps/api/src/lib/
// placeholders.ts, used only for the preview. Keep the two in step.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Empty, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag,
  Tooltip, Typography, message,
} from 'antd';
import { useAuth } from '../../context/AuthContext';

const { Title, Text, Paragraph } = Typography;
const API_ROOT = import.meta.env.VITE_API_URL ?? '';
const BASE = `${API_ROOT}/api/carrier-communication`;

interface Carrier { id: number; name: string; partnerType: string; active: boolean }
interface Contact { id: number; name: string; title: string | null; email: string; phone: string | null }
interface Group { id: number; company: string }
interface Template {
  id: number; name: string; subject: string; body: string; createdById: number | null;
  createdBy: { id: number; name: string } | null; updatedAt: string;
}
interface Recipient {
  id: number; toEmail: string; toName: string | null; status: string; error: string | null;
  sentAt: string | null; providerId: string | null; eventDetail: string | null;
}
interface SentMessage {
  id: number; subject: string; body: string; createdAt: string;
  carrier: { id: number; name: string; partnerType: string };
  group: { id: number; company: string } | null;
  template: { id: number; name: string } | null;
  sentByUser: { id: number; name: string; email: string };
  recipients: Recipient[];
}

const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: 'contact_name', label: 'Contact name' },
  { key: 'carrier_name', label: 'Carrier name' },
  { key: 'group_name', label: 'Group name' },
  { key: 'sender_name', label: 'Your name' },
  { key: 'sender_email', label: 'Your email' },
  { key: 'today', label: "Today's date" },
];

// Same rule as apps/api/src/etl/groupMatch.ts normalizeGroupName (used by the
// API and the nightly EN loader): ignore case, punctuation and extra spaces.
function normalizeGroupName(name: string): string {
  return name.toLowerCase().replace(/\bdba\b/g, 'dba').replace(/[.,'"()&_]/g, '').replace(/\s+/g, ' ').trim();
}

const NEW_GROUP = -1;

function renderPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : whole;
  });
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && !(res.status === 502 && data && typeof data.sent === 'number')) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function PlaceholderHelp({ onInsert }: { onInsert?: (token: string) => void }) {
  return (
    <Space size={[4, 4]} wrap style={{ marginBottom: 8 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{onInsert ? 'Insert:' : 'Placeholders:'}</Text>
      {PLACEHOLDERS.map((p) => (
        <Tooltip key={p.key} title={`{{${p.key}}}`}>
          <Tag
            style={{ cursor: onInsert ? 'pointer' : 'default', marginInlineEnd: 0 }}
            onClick={onInsert ? () => onInsert(`{{${p.key}}}`) : undefined}
          >
            {p.label}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

// --- canned message editor (shared by both tabs) ------------------------------

function TemplateModal({
  open, initial, onClose, onSaved,
}: {
  open: boolean;
  initial: Partial<Template> | null;
  onClose: () => void;
  onSaved: (t: Template) => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) form.setFieldsValue({ name: initial?.name ?? '', subject: initial?.subject ?? '', body: initial?.body ?? '' });
  }, [open, initial, form]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const saved = initial?.id
        ? await api<Template>(`${BASE}/templates/${initial.id}`, jsonInit('PUT', values))
        : await api<Template>(`${BASE}/templates`, jsonInit('POST', values));
      message.success('Canned message saved');
      onSaved(saved);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={initial?.id ? 'Edit canned message' : 'New canned message'}
      onCancel={onClose}
      onOk={save}
      okText="Save"
      confirmLoading={saving}
      width={720}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Name (only you and your team see this)" rules={[{ required: true, message: 'Name is required' }]}>
          <Input placeholder="e.g. Termination - please confirm" maxLength={120} />
        </Form.Item>
        <Form.Item name="subject" label="Subject" rules={[{ required: true, message: 'Subject is required' }]}>
          <Input maxLength={200} />
        </Form.Item>
        <PlaceholderHelp />
        <Form.Item name="body" label="Message" rules={[{ required: true, message: 'Message is required' }]}>
          <Input.TextArea autoSize={{ minRows: 8, maxRows: 20 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// --- Send Message ---------------------------------------------------------------

function SendTab({
  templates, onTemplatesChanged, onSent,
}: {
  templates: Template[];
  onTemplatesChanged: () => void;
  onSent: () => void;
}) {
  const { user } = useAuth();
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [carrierId, setCarrierId] = useState<number | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<number[]>([]);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; failures: { email: string; error: string }[] } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [addingGroup, setAddingGroup] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactForm] = Form.useForm();

  useEffect(() => {
    api<Carrier[]>(`${API_ROOT}/api/carriers?type=CARRIER,TPA`).then(setCarriers).catch(() => message.error('Could not load carriers'));
    api<Group[]>(`${API_ROOT}/api/groups`).then(setGroups).catch(() => message.error('Could not load groups'));
  }, []);

  useEffect(() => {
    setContacts([]);
    setPicked([]);
    if (!carrierId) return;
    setContactsLoading(true);
    api<Contact[]>(`${API_ROOT}/api/carriers/${carrierId}/contacts`)
      .then(setContacts)
      .catch(() => message.error('Could not load contacts'))
      .finally(() => setContactsLoading(false));
  }, [carrierId]);

  const carrier = carriers.find((c) => c.id === carrierId) ?? null;
  const group = groups.find((g) => g.id === groupId) ?? null;
  const recipients = mode === 'all' ? contacts : contacts.filter((c) => picked.includes(c.id));
  const uniqueCount = new Set(recipients.map((r) => r.email.trim().toLowerCase())).size;

  const carrierOptions = useMemo(() => {
    const opt = (t: string) => carriers
      .filter((c) => c.partnerType === t && c.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
    return [
      { label: 'Carriers', options: opt('CARRIER') },
      { label: 'TPAs / Administrators', options: opt('TPA') },
    ];
  }, [carriers]);

  const applyTemplate = (id: number | null) => {
    const t = templates.find((x) => x.id === id);
    const doApply = () => {
      setTemplateId(id);
      if (t) { setSubject(t.subject); setBody(t.body); }
    };
    if (t && (subject.trim() || body.trim()) && (subject !== t.subject || body !== t.body)) {
      Modal.confirm({
        title: 'Replace what you have written?',
        content: `The subject and message will be replaced with "${t.name}".`,
        okText: 'Replace',
        onOk: doApply,
      });
    } else {
      doApply();
    }
  };

  const insertToken = (token: string) => {
    const at = cursor ?? body.length;
    setBody(body.slice(0, at) + token + body.slice(at));
    setCursor(at + token.length);
  };

  const preview = useMemo(() => {
    const first = recipients[0];
    const vars = {
      contact_name: first?.name ?? '',
      carrier_name: carrier?.name ?? '',
      group_name: group?.company ?? '',
      sender_name: user?.name ?? '',
      sender_email: user?.email ?? '',
      today: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    };
    return { to: first, subject: renderPlaceholders(subject, vars), body: renderPlaceholders(body, vars) };
  }, [recipients, carrier, group, subject, body, user]);

  const unknownTokens = useMemo(() => {
    const known = new Set(PLACEHOLDERS.map((p) => p.key));
    const found = [...`${subject}\n${body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
    return [...new Set(found.filter((k) => !known.has(k)))];
  }, [subject, body]);
  const usesGroupName = /\{\{\s*group_name\s*\}\}/i.test(`${subject}\n${body}`);

  // Group picker options, plus '+ Add "<typed name>" as a new group' when
  // what's typed doesn't match an existing group.
  const typedGroup = groupSearch.replace(/\s+/g, ' ').trim();
  const groupOptions = useMemo(() => {
    const opts: { value: number; label: string }[] = [...groups]
      .sort((a, b) => a.company.localeCompare(b.company))
      .map((g) => ({ value: g.id, label: g.company }));
    if (typedGroup && !groups.some((g) => normalizeGroupName(g.company) === normalizeGroupName(typedGroup))) {
      opts.unshift({ value: NEW_GROUP, label: `+ Add "${typedGroup}" as a new group` });
    }
    return opts;
  }, [groups, typedGroup]);

  const pickGroup = async (v: number | undefined) => {
    if (v !== NEW_GROUP) { setGroupId(v ?? null); return; }
    const name = typedGroup;
    setAddingGroup(true);
    try {
      const g = await api<Group & { existed: boolean }>(`${BASE}/groups`, jsonInit('POST', { company: name }));
      setGroups((list) => (list.some((x) => x.id === g.id) ? list : [...list, { id: g.id, company: g.company }]));
      setGroupId(g.id);
      setGroupSearch('');
      if (g.existed) message.info(`"${g.company}" is already in PipeLine, so that group was picked.`);
      else message.success(`Group "${g.company}" added to PipeLine`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAddingGroup(false);
    }
  };

  // "+ Add contact": saves a new contact on this carrier (same as Databases →
  // Carriers → Contacts; any role may) and ticks it for this message.
  const saveContact = async () => {
    const values = await contactForm.validateFields();
    setContactSaving(true);
    try {
      const res = await fetch(`${API_ROOT}/api/carriers/${carrierId}/contacts`, jsonInit('POST', values));
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.contact) {
        // Already on file: just pick it.
        const c = body.contact as Contact;
        if (mode === 'some') setPicked((p) => (p.includes(c.id) ? p : [...p, c.id]));
        message.info(body.error);
        setContactOpen(false);
        contactForm.resetFields();
        return;
      }
      if (!res.ok) throw new Error(body.error || 'Could not add the contact');
      const c = body as Contact;
      setContacts((list) => [...list, c].sort((a, b) => a.name.localeCompare(b.name)));
      if (mode === 'some') setPicked((p) => [...p, c.id]);
      message.success(`${c.name} added to ${carrier?.name ?? 'this carrier'}`);
      setContactOpen(false);
      contactForm.resetFields();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setContactSaving(false);
    }
  };

  const canSend = !!carrierId && recipients.length > 0 && subject.trim() !== '' && body.trim() !== '';

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const r = await api<{ sent: number; failed: number; failures: { email: string; error: string }[] }>(
        `${BASE}/messages`,
        jsonInit('POST', {
          carrierId, groupId, templateId, subject, body,
          allContacts: mode === 'all',
          contactIds: mode === 'all' ? [] : picked,
        }),
      );
      setResult(r);
      if (r.failed === 0) {
        message.success(`Sent ${r.sent} email${r.sent === 1 ? '' : 's'} to ${carrier?.name}`);
        setSubject(''); setBody(''); setTemplateId(null); setCursor(null);
      } else {
        message.warning(`Sent ${r.sent}, failed ${r.failed}`);
      }
      onSent();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Card title="New message" style={{ flex: '1 1 560px', minWidth: 420 }}>
        <Form layout="vertical">
          <Form.Item label="Carrier or TPA" required>
            <Select
              showSearch
              allowClear
              placeholder="Search carriers and TPAs..."
              value={carrierId ?? undefined}
              onChange={(v) => setCarrierId(v ?? null)}
              options={carrierOptions}
              filterOption={(input, option) => (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>

          {carrierId && (
            <Form.Item label="Send to" required>
              {contactsLoading ? (
                <Text type="secondary">Loading contacts...</Text>
              ) : contacts.length === 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message="No contacts on file for this company"
                  description="Add one here and it's saved to the company for next time."
                  action={<Button size="small" type="primary" onClick={() => setContactOpen(true)}>+ Add contact</Button>}
                />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                    <Radio value="all">All contacts ({contacts.length})</Radio>
                    <Radio value="some">Choose contacts</Radio>
                  </Radio.Group>
                  <Checkbox.Group
                    value={mode === 'all' ? contacts.map((c) => c.id) : picked}
                    onChange={(v) => setPicked(v as number[])}
                    disabled={mode === 'all'}
                    style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}
                  >
                    {contacts.map((c) => (
                      <Checkbox key={c.id} value={c.id}>
                        <span>{c.name} &lt;{c.email}&gt;</span>
                        {c.title && <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{c.title}</div>}
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                  <Button size="small" onClick={() => setContactOpen(true)}>+ Add contact</Button>
                </Space>
              )}
            </Form.Item>
          )}

          <Form.Item
            label="About group (optional)"
            extra="Fills in {{group_name}} and is saved with the message. Not listed? Type the name and pick '+ Add' to add it to PipeLine. Use the name as Employee Navigator spells it, so EN's data links to it later."
          >
            <Select
              showSearch
              allowClear
              placeholder="Pick or type a group..."
              loading={addingGroup}
              disabled={addingGroup}
              value={groupId ?? undefined}
              searchValue={groupSearch}
              onSearch={setGroupSearch}
              onChange={(v) => pickGroup(v as number | undefined)}
              onBlur={() => setGroupSearch('')}
              options={groupOptions}
              filterOption={(input, option) =>
                option?.value === NEW_GROUP || (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Form.Item label="Canned message (optional)">
            <Select
              allowClear
              showSearch
              placeholder={templates.length ? 'Start from a canned message...' : 'No canned messages yet'}
              value={templateId ?? undefined}
              onChange={(v) => applyTemplate(v ?? null)}
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
              filterOption={(input, option) => (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>

          <Form.Item label="Subject" required>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </Form.Item>

          <Form.Item label="Message" required style={{ marginBottom: 8 }}>
            <PlaceholderHelp onInsert={insertToken} />
            <Input.TextArea
              value={body}
              onChange={(e) => { setBody(e.target.value); setCursor(e.target.selectionStart); }}
              onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart)}
              autoSize={{ minRows: 10, maxRows: 24 }}
              placeholder="Write your message, or start from a canned message above."
            />
          </Form.Item>

          {unknownTokens.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`Unknown placeholder${unknownTokens.length > 1 ? 's' : ''}: ${unknownTokens.map((t) => `{{${t}}}`).join(', ')}. ${unknownTokens.length > 1 ? 'They' : 'It'} will be sent as written.`}
            />
          )}
          {usesGroupName && !group && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="The message uses {{group_name}} but no group is picked, so it will be blank." />
          )}

          <Space wrap>
            <Popconfirm
              title={`Send ${uniqueCount} email${uniqueCount === 1 ? '' : 's'} to ${carrier?.name ?? ''}?`}
              description="Each contact gets their own copy, from you. Replies come to your email."
              okText="Send"
              onConfirm={send}
              disabled={!canSend}
            >
              <Button type="primary" loading={sending} disabled={!canSend}>
                Send{uniqueCount ? ` (${uniqueCount})` : ''}
              </Button>
            </Popconfirm>
            <Button onClick={() => setSaveOpen(true)} disabled={!subject.trim() || !body.trim()}>Save as canned message</Button>
            <Button onClick={() => { setSubject(''); setBody(''); setTemplateId(null); setResult(null); setCursor(null); }}>Clear</Button>
          </Space>

          {result && result.failed > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 16 }}
              message={`${result.failed} email${result.failed === 1 ? '' : 's'} not sent (${result.sent} sent)`}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{result.failures.map((f) => <li key={f.email}>{f.email}: {f.error}</li>)}</ul>}
            />
          )}
        </Form>
      </Card>

      <Card title="Preview" style={{ flex: '1 1 420px', minWidth: 360 }} size="small">
        {!preview.to && !subject && !body ? (
          <Empty description="Pick a carrier and write a message to see it here." />
        ) : (
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              <Text type="secondary">To: </Text>
              {preview.to ? `${preview.to.name} <${preview.to.email}>` : '(no contact selected)'}
              {recipients.length > 1 && <Text type="secondary"> and {recipients.length - 1} more, each sent separately</Text>}
            </Paragraph>
            <Paragraph style={{ marginBottom: 4 }}>
              <Text type="secondary">From: </Text>
              {/* Same rule as apps/api/src/lib/mailer.ts fromForSender (benebloc.com is the verified domain). */}
              {user?.email?.toLowerCase().endsWith('@benebloc.com')
                ? <>{user.name} &lt;{user.email}&gt;</>
                : <>{user?.name} via BeneBloc</>}
            </Paragraph>
            <Paragraph style={{ marginBottom: 4 }}>
              <Text type="secondary">Replies go to: </Text>{user?.name} &lt;{user?.email}&gt;
            </Paragraph>
            <Paragraph strong style={{ marginBottom: 12 }}>
              <Text type="secondary" strong={false}>Subject: </Text>{preview.subject}
            </Paragraph>
            <div style={{ whiteSpace: 'pre-wrap', border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, background: '#fafafa', minHeight: 160 }}>
              {preview.body}
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={contactOpen}
        title={`Add a contact for ${carrier?.name ?? ''}`}
        okText="Add contact"
        confirmLoading={contactSaving}
        onOk={saveContact}
        onCancel={() => { setContactOpen(false); contactForm.resetFields(); }}
        destroyOnHidden
      >
        <Form form={contactForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Name (a person or a team)" rules={[{ required: true, message: 'Name is required' }]}>
            <Input autoFocus placeholder="e.g. Jane Smith, or Aetna Billing" maxLength={120} />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, message: 'Email is required' }, { type: 'email', message: 'Enter a valid email address' }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="title" label="Title / what they handle (optional)">
            <Input placeholder="e.g. Billing questions, Account Manager" maxLength={200} />
          </Form.Item>
          <Form.Item name="phone" label="Phone (optional)">
            <Input maxLength={40} />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Saved to this company's contacts (Databases → Carriers / TPAs &amp; Vendors), so it's there next time too.
        </Text>
      </Modal>

      <TemplateModal
        open={saveOpen}
        initial={{ name: '', subject, body }}
        onClose={() => setSaveOpen(false)}
        onSaved={(t) => { setSaveOpen(false); setTemplateId(t.id); onTemplatesChanged(); }}
      />
    </div>
  );
}

// --- Sent Messages ------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  sent: 'green', delivered: 'green', sending: 'blue', failed: 'red', bounced: 'red', rejected: 'red', spam: 'orange',
};

function HistoryTab({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<SentMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [carrierFilter, setCarrierFilter] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<SentMessage[]>(`${BASE}/messages${carrierFilter ? `?carrierId=${carrierFilter}` : ''}`)
      .then(setRows)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [carrierFilter]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const carrierOptions = useMemo(() => {
    const m = new Map<number, string>();
    rows.forEach((r) => m.set(r.carrier.id, r.carrier.name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  }, [rows]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Select
          allowClear
          showSearch
          placeholder="All carriers"
          style={{ width: 320 }}
          value={carrierFilter ?? undefined}
          onChange={(v) => setCarrierFilter(v ?? null)}
          options={carrierOptions}
          filterOption={(input, option) => (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())}
        />
        <Button onClick={load}>Refresh</Button>
      </Space>
      <Table<SentMessage>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 25 }}
        expandable={{
          expandedRowRender: (r) => (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 420px' }}>
                <Text type="secondary">Message as written{r.template ? ` (from "${r.template.name}")` : ''}:</Text>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 4, padding: 8, background: '#fafafa', borderRadius: 4 }}>{r.body}</div>
              </div>
              <div style={{ flex: '1 1 320px' }}>
                <Text type="secondary">Recipients:</Text>
                <ul style={{ marginTop: 4, paddingLeft: 18 }}>
                  {r.recipients.map((x) => (
                    <li key={x.id}>
                      {x.toName ? `${x.toName} <${x.toEmail}>` : x.toEmail} <Tag color={STATUS_COLOR[x.status]}>{x.status}</Tag>
                      {(x.error || x.eventDetail) && <div style={{ fontSize: 12, color: '#cf1322' }}>{x.error ?? x.eventDetail}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ),
        }}
        columns={[
          {
            title: 'Sent', dataIndex: 'createdAt', width: 170,
            render: (v: string) => new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
          },
          { title: 'Carrier', key: 'carrier', render: (_, r) => r.carrier.name },
          { title: 'Group', key: 'group', render: (_, r) => r.group?.company ?? '' },
          { title: 'Subject', dataIndex: 'subject', ellipsis: true },
          { title: 'Sent by', key: 'by', width: 160, render: (_, r) => r.sentByUser.name },
          {
            title: 'Recipients', key: 'rcpt', width: 200,
            render: (_, r) => {
              const counts = r.recipients.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
              return (
                <Space size={4} wrap>
                  {Object.entries(counts).map(([s, n]) => <Tag key={s} color={STATUS_COLOR[s]}>{n} {s}</Tag>)}
                </Space>
              );
            },
          },
        ]}
      />
    </Space>
  );
}

// --- Canned Messages ------------------------------------------------------------

function TemplatesTab({ templates, loading, onChanged }: { templates: Template[]; loading: boolean; onChanged: () => void }) {
  const { user } = useAuth();
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const canEdit = (t: Template) => user?.role === 'SUPER_USER' || t.createdById === user?.id;

  const remove = async (t: Template) => {
    try {
      await api(`${BASE}/templates/${t.id}`, { method: 'DELETE' });
      message.success('Canned message deleted');
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Button type="primary" onClick={() => setEditing({})}>+ New canned message</Button>
        <Text type="secondary">Shared with everyone who uses Carrier Communication. Only the person who created one (or a Super User) can change it.</Text>
      </Space>
      <Table<Template>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={templates}
        pagination={false}
        expandable={{ expandedRowRender: (t) => <div style={{ whiteSpace: 'pre-wrap' }}>{t.body}</div> }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Subject', dataIndex: 'subject', ellipsis: true },
          { title: 'Created by', key: 'by', width: 180, render: (_, t) => t.createdBy?.name ?? '' },
          {
            title: '', key: 'actions', width: 150,
            render: (_, t) => canEdit(t) && (
              <Space>
                <Button size="small" onClick={() => setEditing(t)}>Edit</Button>
                <Popconfirm title={`Delete "${t.name}"?`} okText="Delete" onConfirm={() => remove(t)}>
                  <Button size="small" danger>Delete</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <TemplateModal
        open={editing !== null}
        initial={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); onChanged(); }}
      />
    </Space>
  );
}

// --- page -------------------------------------------------------------------------

export default function CarrierCommunication() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const loadTemplates = useCallback(() => {
    setTemplatesLoading(true);
    api<Template[]>(`${BASE}/templates`)
      .then(setTemplates)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setTemplatesLoading(false));
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Title level={4} style={{ margin: 0 }}>Carrier Communication</Title>
      <Tabs
        defaultActiveKey="send"
        items={[
          {
            key: 'send', label: 'Send Message',
            children: <SendTab templates={templates} onTemplatesChanged={loadTemplates} onSent={() => setHistoryKey((k) => k + 1)} />,
          },
          { key: 'history', label: 'Sent Messages', children: <HistoryTab refreshKey={historyKey} /> },
          {
            key: 'templates', label: `Canned Messages (${templates.length})`,
            children: <TemplatesTab templates={templates} loading={templatesLoading} onChanged={loadTemplates} />,
          },
        ]}
      />
    </Space>
  );
}
