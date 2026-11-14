import { useState, useEffect, useCallback } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Tag,
  Popconfirm,
  Typography,
  message,
  type TableProps,
} from 'antd';
import { useAuth } from '../context/AuthContext';

// ---------------------------------------------------------------------------
// NOTE: reconstructed against the documented conventions for this page
// (PipeLine Auth/Users/Roles doc, Divisions doc, and the division-scoping
// doc), not against the live file -- this session did not have access to the
// actual apps/web/src/pages/Users.tsx source. Diff/merge this against the
// real file rather than overwriting it blind. See the one flagged
// assumption below (BrokerRow.name).
// ---------------------------------------------------------------------------

type Role = 'SUPER_USER' | 'BROKER_USER';

interface UserRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  brokerId: number | null;
  restrictedDivisionId: number | null;
  active: boolean;
  // Two-step sign-in (see apps/api/src/lib/twoStep.ts)
  totpOnAt: string | null;
  totpNeedsLink: boolean;
  totpLockedUntil: string | null;
  // Accounts work like Translatus: people choose their own password from an
  // emailed link. hasPassword=false: invited, hasn't finished the welcome email.
  hasPassword: boolean;
  // An unused link a Super User sent (to copy if the email didn't arrive).
  pendingLink: { kind: 'welcome' | 'password' | 'authenticator'; expiresAt: string; url: string } | null;
}

interface LinkResult { email: string; emailed: boolean; kind?: string; url: string; expiresAt: string }

const LINK_LABEL: Record<string, string> = {
  welcome: 'welcome (set up account)',
  password: 'new password',
  authenticator: 'new authenticator app',
};

const longDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

// After a link goes out: whether the email went, and the link itself to copy.
function showLink(title: string, r: LinkResult, what: string) {
  Modal.info({
    title,
    width: 580,
    content: (
      <div>
        <p>{r.emailed ? `We emailed ${r.email} ${what}.` : <strong>The email to {r.email} did not go out.</strong>}</p>
        <p>{r.emailed ? 'If it doesn’t arrive, send them this link another way:' : 'Send them this link another way (it works once):'}</p>
        <Typography.Paragraph copyable style={{ wordBreak: 'break-all', background: '#fafafa', padding: 8, borderRadius: 4 }}>
          {r.url}
        </Typography.Paragraph>
        <p style={{ color: 'rgba(0,0,0,0.45)', marginBottom: 0 }}>Works once, until {longDate(r.expiresAt)}.</p>
      </div>
    ),
  });
}

interface DivisionRow {
  id: number;
  key: string;
  name: string;
}

interface BrokerRow {
  id: number;
  companyName: string | null;
  firstName: string;
  lastName: string;
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [divisions, setDivisions] = useState<DivisionRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [superModalOpen, setSuperModalOpen] = useState(false);
  const [brokerModalOpen, setBrokerModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [superForm] = Form.useForm();
  const [brokerForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, divisionsRes, brokersRes] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/divisions'),
        fetch('/api/brokers'),
      ]);
      if (usersRes.ok) setUsers(await usersRes.json());
      if (divisionsRes.ok) setDivisions(await divisionsRes.json());
      if (brokersRes.ok) setBrokers(await brokersRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function setRestrictedDivision(user: UserRow, restrictedDivisionId: number | null) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restrictedDivisionId }),
    });
    if (res.ok) {
      loadAll();
    } else {
      const body = await res.json().catch(() => ({}));
      message.error(body.error || 'Failed to update restricted division');
    }
  }

  async function setActive(user: UserRow, active: boolean) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    if (res.ok) {
      loadAll();
    } else {
      message.error('Failed to update user');
    }
  }

  async function handleCreateSuperUser() {
    const values = await superForm.validateFields();
    setCreating(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          role: 'SUPER_USER',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to create user');
      showLink(`Super User added: ${body.email}`, body, 'a welcome link to choose a password and connect their phone');
      superForm.resetFields();
      setSuperModalOpen(false);
      loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateBrokerUser() {
    const values = await brokerForm.validateFields();
    setCreating(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          role: 'BROKER_USER',
          brokerId: values.brokerId,
          // Omit the key entirely when left blank rather than sending null,
          // since POST /api/users treats an absent field as "unset" and this
          // keeps the payload shape identical to what the docs show working
          // in the live curl verification test.
          ...(values.restrictedDivisionId ? { restrictedDivisionId: values.restrictedDivisionId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to create user');
      showLink(`Broker User added: ${body.email}`, body, 'a welcome link to choose a password and connect their phone');
      brokerForm.resetFields();
      setBrokerModalOpen(false);
      loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

   function handleOpenEdit(user: UserRow) {
    setEditingUser(user);
    editForm.setFieldsValue({ name: user.name, email: user.email });
    setEditModalOpen(true);
  }

  async function handleSaveEdit() {
    if (!editingUser) return;
    const values = await editForm.validateFields();
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = {
        name: values.name,
        email: values.email,
      };
      const res = await fetch(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to update user');
      }
      message.success('User updated');
      setEditModalOpen(false);
      setEditingUser(null);
      loadAll();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setSavingEdit(false);
    }
  }

  // Lost or new phone: clears their authenticator, signs them out, emails a
  // one-time link. The link is shown here too in case the email doesn't arrive.
  async function resetAuthenticator(user: UserRow) {
    const res = await fetch(`/api/users/${user.id}/reset-authenticator`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      message.error(body.error || 'Failed to reset authenticator');
      return;
    }
    loadAll();
    showLink(`Authenticator reset for ${body.email}`, body, 'a link to connect their new phone. They have been signed out');
  }

  // A new-password link (or the welcome link again, if they never finished).
  async function sendLink(user: UserRow) {
    const res = await fetch(`/api/users/${user.id}/send-link`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      message.error(body.error || 'Failed to send the link');
      return;
    }
    loadAll();
    showLink(
      body.kind === 'welcome' ? `Welcome link sent again to ${body.email}` : `Password link sent to ${body.email}`,
      body,
      body.kind === 'welcome' ? 'the welcome link again' : 'a link to choose a new password',
    );
  }

  const columns: TableProps<UserRow>['columns'] = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: Role) => <Tag color={role === 'SUPER_USER' ? 'gold' : 'blue'}>{role}</Tag>,
    },
    {
      title: 'Broker ID',
      dataIndex: 'brokerId',
      key: 'brokerId',
      render: (brokerId: number | null) => brokerId ?? '-',
    },
    {
      title: 'Restricted Division',
      key: 'restrictedDivisionId',
      render: (_: unknown, user: UserRow) => {
        if (user.role === 'SUPER_USER') return '-';
        return (
          <Select
            allowClear
            placeholder="All divisions"
            style={{ minWidth: 200 }}
            value={user.restrictedDivisionId ?? undefined}
            options={divisions.map((d) => ({ value: d.id, label: d.name }))}
            onChange={(value) => setRestrictedDivision(user, value ?? null)}
            onClear={() => setRestrictedDivision(user, null)}
          />
        );
      },
    },
        {
      title: 'Active',
      dataIndex: 'active',
      key: 'active',
      render: (active: boolean, user: UserRow) => (
        <Switch checked={active} disabled={user.id === me?.id} onChange={(checked) => setActive(user, checked)} />
      ),
    },
    {
      title: 'Sign-in',
      key: 'signIn',
      render: (_: unknown, user: UserRow) => {
        const locked = user.totpLockedUntil && new Date(user.totpLockedUntil) > new Date();
        const tag = !user.hasPassword
          ? <Tag color="blue">Invited, hasn't set up yet</Tag>
          : user.totpOnAt
            ? <Tag color="green">Two-step on since {new Date(user.totpOnAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Tag>
            : user.totpNeedsLink
              ? <Tag color="orange">Authenticator reset, waiting</Tag>
              : <Tag>Phone not connected yet</Tag>;
        return (
          <div>
            {tag}
            {locked && <Tag color="red">Locked (wrong codes)</Tag>}
            {user.pendingLink && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <Typography.Text type="secondary">
                  Unused {LINK_LABEL[user.pendingLink.kind] ?? user.pendingLink.kind} link, until {longDate(user.pendingLink.expiresAt)}.{' '}
                </Typography.Text>
                <Typography.Text copyable={{ text: user.pendingLink.url, tooltips: ['Copy the link', 'Copied'] }}>Copy</Typography.Text>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, user: UserRow) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" onClick={() => handleOpenEdit(user)}>
            Edit
          </Button>
          {user.id !== me?.id && user.active && (
            <Popconfirm
              title={user.hasPassword ? 'Email a new-password link?' : 'Send the welcome email again?'}
              description={user.hasPassword
                ? 'They choose a new password from the link (works 24 hours). Their authenticator app stays the same.'
                : 'They haven’t finished setting up. This sends a new welcome link (works 7 days).'}
              okText="Send"
              onConfirm={() => sendLink(user)}
            >
              <Button size="small">{user.hasPassword ? 'Send password link' : 'Resend welcome'}</Button>
            </Popconfirm>
          )}
          {user.id !== me?.id && user.active && (user.totpOnAt || user.totpNeedsLink) && (
            <Popconfirm
              title="Reset this person's authenticator?"
              description="For a lost or new phone. They're signed out and emailed a link to connect a new phone."
              okText="Reset"
              onConfirm={() => resetAuthenticator(user)}
            >
              <Button size="small">Reset authenticator</Button>
            </Popconfirm>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>Users</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => setBrokerModalOpen(true)}>+ New Broker User</Button>
          <Button type="primary" onClick={() => setSuperModalOpen(true)}>
            + New Super User
          </Button>
        </div>
      </div>

      <Table<UserRow> rowKey="id" loading={loading} columns={columns} dataSource={users} pagination={{ pageSize: 10 }} />

      <Modal
        title="New Super User"
        open={superModalOpen}
        onCancel={() => setSuperModalOpen(false)}
        onOk={handleCreateSuperUser}
        confirmLoading={creating}
        destroyOnClose
      >
        <Form form={superForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <p style={{ color: 'rgba(0,0,0,0.45)' }}>
            They'll get a welcome email with a link to choose their own password and connect the authenticator app on their phone.
          </p>
        </Form>
      </Modal>

      <Modal
        title="New Broker User"
        open={brokerModalOpen}
        onCancel={() => setBrokerModalOpen(false)}
        onOk={handleCreateBrokerUser}
        confirmLoading={creating}
        destroyOnClose
      >
        <Form form={brokerForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <p style={{ color: 'rgba(0,0,0,0.45)' }}>
            They'll get a welcome email with a link to choose their own password and connect the authenticator app on their phone.
          </p>
          <Form.Item
            name="brokerId"
            label="Broker"
            rules={[{ required: true, message: 'Select the broker this user belongs to' }]}
          >
            <Select
              placeholder="Select a broker"
              showSearch
              optionFilterProp="label"
              options={brokers.map((b) => ({
                value: b.id,
                label: b.companyName ? `${b.companyName} (${b.firstName} ${b.lastName})` : `${b.firstName} ${b.lastName}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="restrictedDivisionId"
            label="Restrict to division (optional)"
            tooltip="Leave blank to let this user see all divisions."
          >
            <Select allowClear placeholder="All divisions" options={divisions.map((d) => ({ value: d.id, label: d.name }))} />
          </Form.Item>
               </Form>
      </Modal>

      <Modal
        title="Edit User"
        open={editModalOpen}
        onCancel={() => {
          setEditModalOpen(false);
          setEditingUser(null);
        }}
        onOk={handleSaveEdit}
        confirmLoading={savingEdit}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <p style={{ color: 'rgba(0,0,0,0.45)', marginBottom: 0 }}>
            Passwords are chosen by the person. To give them a new one, use <strong>Send password link</strong> in the user list.
          </p>
        </Form>
      </Modal>
    </div>
  );
}
