// Destination: apps/web/src/pages/Settings.tsx
//
// My account: change my own password, and my two-step sign-in status.
// Same as Translatus's Account page. Changing the password signs out my other
// sessions (this one stays signed in).
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Typography, message } from 'antd';
import { useAuth } from '../context/AuthContext';

const { Paragraph, Text } = Typography;

export default function Settings() {
  const { user } = useAuth();
  const [twoStepOnAt, setTwoStepOnAt] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setTwoStepOnAt(b?.twoStepOnAt ?? null))
      .catch(() => setTwoStepOnAt(null));
  }, []);

  async function changePassword(v: { current: string; password: string; confirm: string }) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setError(b.error || 'Could not change the password'); return; }
      form.resetFields();
      message.success('Password changed. You were signed out everywhere else.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 640 }}>
      <h2 style={{ margin: 0 }}>Settings</h2>

      <Card title="My account">
        <Paragraph style={{ marginBottom: 0 }}>
          <Text type="secondary">Signed in as </Text>{user?.name} &lt;{user?.email}&gt;
        </Paragraph>
      </Card>

      <Card title="Change my password">
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical" onFinish={changePassword} style={{ maxWidth: 400 }}>
          <input type="email" name="username" value={user?.email ?? ''} autoComplete="username" readOnly hidden />
          <Form.Item name="current" label="Current password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="password"
            label="New password"
            extra="At least 12 characters. A short sentence you'll remember works well."
            rules={[{ required: true }, { min: 12, message: 'At least 12 characters' }, { max: 200 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Type the new password again"
            dependencies={['password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_, v) => (!v || v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error("The two passwords don't match."))),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>Change password</Button>
        </Form>
      </Card>

      <Card title="Two-step sign-in">
        <Paragraph>
          {twoStepOnAt === undefined
            ? 'Loading...'
            : twoStepOnAt
              ? <>On since {new Date(twoStepOnAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. Each time you sign in, you type your password and the 6-digit code from the authenticator app on your phone.</>
              : <>Not set up yet. You'll connect an authenticator app the next time you sign in.</>}
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Getting a new phone, or lost yours? Ask {user?.role === 'SUPER_USER' ? 'another Super User' : 'a Super User'} to reset your authenticator under Users. You'll get an email to connect the new phone.
        </Paragraph>
      </Card>
    </Space>
  );
}
