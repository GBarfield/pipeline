import { useState } from 'react';
import { Form, Input, Button, Card, Alert } from 'antd';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onFinish(values: { email: string; password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.email, values.password);
      // No redirect needed here — AuthGate (App.tsx) re-renders Shell once
      // `user` is set, showing whatever URL was already in the address bar.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card title="PipeLine" style={{ width: 360 }}>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="email" label="Email" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block>
            Log in
          </Button>
        </Form>
      </Card>
    </div>
  );
}