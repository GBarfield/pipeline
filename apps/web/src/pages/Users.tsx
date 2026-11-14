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
          password: values.password,
          role: 'SUPER_USER',
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create user');
      }
      message.success('Super User created');
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
          password: values.password,
          role: 'BROKER_USER',
          brokerId: values.brokerId,
          // Omit the key entirely when left blank rather than sending null,
          // since POST /api/users treats an absent field as "unset" and this
          // keeps the payload shape identical to what the docs show working
          // in the live curl verification test.
          ...(values.restrictedDivisionId ? { restrictedDivisionId: values.restrictedDivisionId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create user');
      }
      message.success('Broker User created');
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
    editForm.setFieldsValue({ name: user.name, email: user.email, password: '' });
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
      if (values.password) {
        body.password = values.password;
      }
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
    Modal.info({
      title: `Authenticator reset for ${body.email}`,
      width: 560,
      content: (
        <div>
          <p>They have been signed out. {body.emailed ? 'We emailed them a link to connect their new phone.' : <strong>The email did not go out.</strong>}</p>
          <p>{body.emailed ? 'If it doesn’t arrive, send them this link another way.' : 'Send them this link another way (it works once):'}</p>
          <Typography.Paragraph copyable style={{ wordBreak: 'break-all', background: '#fafafa', padding: 8, borderRadius: 4 }}>
            {body.url}
          </Typography.Paragraph>
          <p style={{ color: 'rgba(0,0,0,0.45)', marginBottom: 0 }}>
            Works once, until {new Date(body.expiresAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. They’ll type their password, then scan a new QR code.
          </p>
        </div>
      ),
    });
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
        <Switch checked={active} onChange={(checked) => setActive(user, checked)} />
      ),
    },
    {
      title: 'Two-step',
      key: 'twoStep',
      render: (_: unknown, user: UserRow) => {
        const locked = user.totpLockedUntil && new Date(user.totpLockedUntil) > new Date();
        const tag = user.totpOnAt
          ? <Tag color="green">On since {new Date(user.totpOnAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</Tag>
          : user.totpNeedsLink
            ? <Tag color="orange">Reset, waiting for link</Tag>
            : <Tag>Not set up yet</Tag>;
        return <>{tag}{locked && <Tag color="red">Locked (wrong codes)</Tag>}</>;
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
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
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
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
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
          <Form.Item
            name="password"
            label="New Password"
            tooltip="Leave blank to keep the current password."
            rules={[{ min: 8, message: 'At least 8 characters' }]}
          >
            <Input.Password placeholder="Leave blank to keep current password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
