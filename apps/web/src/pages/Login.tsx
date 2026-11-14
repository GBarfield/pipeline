// Destination: apps/web/src/pages/Login.tsx
//
// Sign-in, in two steps (same flow as Translatus):
//   1. email + password
//   2. the 6-digit code from the authenticator app, or, the first time (or
//      after a reset), connecting the app: QR code, tap-to-add link for
//      phones, or a key to type, then one code.
// Also handles /link?token=... (the emailed "set up your authenticator again"
// link): password first, then the same setup step.
// The QR code only ever comes from the server after a right password.
import { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Alert, Typography, Collapse, Spin, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth, SignInError } from '../context/AuthContext';

const { Text, Paragraph, Title } = Typography;

type Step = 'password' | 'code' | 'setup' | 'link';

interface SetupInfo { email: string; qrSvg: string; uri: string; key: string }
interface LinkInfo { kind: string; email: string; name: string; expiresAt: string }

function Shell({ title, subtitle, children, width = 400 }: { title: string; subtitle?: string; children: React.ReactNode; width?: number }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5', padding: 16 }}>
      <Card style={{ width, maxWidth: '100%' }}>
        <div style={{ fontWeight: 600, color: '#1677ff', marginBottom: 4 }}>PipeLine</div>
        <Title level={4} style={{ marginTop: 0 }}>{title}</Title>
        {subtitle && <Paragraph type="secondary">{subtitle}</Paragraph>}
        {children}
      </Card>
    </div>
  );
}

function CodeForm({ button, onDone, onRestart }: { button: string; onDone: (enrolled: boolean) => void; onRestart: (err: string) => void }) {
  const { submitCode } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  async function onFinish(v: { code: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const r = await submitCode(v.code);
      onDone(r.enrolled);
    } catch (err) {
      if (err instanceof SignInError && err.restart) onRestart(err.message);
      else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
        form.setFieldsValue({ code: '' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form form={form} layout="vertical" onFinish={onFinish}>
      {error && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Form.Item name="code" label="6-digit code" rules={[{ required: true, message: 'Type the code from the app' }]}>
        <Input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="123456"
          style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center' }}
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={submitting} block>{button}</Button>
    </Form>
  );
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const linkToken = window.location.pathname === '/link' ? new URLSearchParams(window.location.search).get('token') ?? '' : null;

  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const restart = (msg: string) => {
    setError(msg);
    setSetup(null);
    setStep('password');
  };

  // On load: an emailed link, or a sign-in already half done (page reloaded
  // between the password and the code), or the password step.
  useEffect(() => {
    if (linkToken !== null) {
      setStep('link');
      fetch(`/api/auth/link?token=${encodeURIComponent(linkToken)}`, { credentials: 'include' })
        .then(async (r) => {
          const b = await r.json().catch(() => ({}));
          if (r.ok) setLink(b as LinkInfo);
          else setLinkError(b.error || "This link doesn't work anymore.");
        })
        .catch(() => setLinkError('Could not check the link. Try again.'));
      return;
    }
    fetch('/api/auth/two-step', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) { setStep('password'); return; }
        const b = await r.json();
        if (b.purpose === 'verify') setStep('code');
        else { setSetup(b as SetupInfo); setStep('setup'); }
      })
      .catch(() => setStep('password'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function goToSetup() {
    const r = await fetch('/api/auth/two-step', { credentials: 'include' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { restart(b.error || 'Sign in again.'); return; }
    setSetup(b as SetupInfo);
    setStep('setup');
  }

  async function onPassword(values: { email: string; password: string }) {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const next = await login(values.email, values.password);
      if (next === 'code') setStep('code');
      else await goToSetup();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onLinkPassword(values: { password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: linkToken, password: values.password }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setError(b.error || 'Could not use the link'); return; }
      navigate('/', { replace: true }); // the link is used up; a reload shouldn't show it again
      if (b.next === 'code') setStep('code');
      else await goToSetup();
    } finally {
      setSubmitting(false);
    }
  }

  function done(enrolled: boolean) {
    if (enrolled) message.success('All set. From now on, sign in with your password and the 6-digit code from the app.', 6);
    if (window.location.pathname === '/link') navigate('/', { replace: true });
  }

  if (step === null) {
    return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" /></div>;
  }

  if (step === 'link') {
    if (linkError) {
      return (
        <Shell title="This link doesn't work anymore" subtitle="It may have expired, or it was already used. Each link works only once.">
          <Paragraph>If you already finished setting up, just <a href="/">sign in</a>.</Paragraph>
          <Paragraph>If you still need to connect a phone, ask a Super User to reset your authenticator again. You'll get a new email.</Paragraph>
        </Shell>
      );
    }
    if (!link) return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}><Spin size="large" /></div>;
    const first = link.name.split(' ')[0];
    return (
      <Shell title="Set up your authenticator app again" subtitle={`Step 1 of 2. ${first ? `Hi ${first}. ` : ''}Type your PipeLine password so we know it's you.`}>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onLinkPassword}>
          <Paragraph type="secondary">Signing in as <strong>{link.email}</strong></Paragraph>
          <input type="email" name="username" value={link.email} autoComplete="username" readOnly hidden />
          <Form.Item name="password" label="Your password" rules={[{ required: true }]}>
            <Input.Password autoFocus autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block>Next</Button>
        </Form>
      </Shell>
    );
  }

  if (step === 'code') {
    return (
      <Shell title="Enter your code" subtitle="One more step. Open the authenticator app on your phone, find PipeLine, and type the 6-digit number it shows.">
        <CodeForm button="Sign in" onDone={done} onRestart={restart} />
        <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 8 }}>
          The number changes every 30 seconds. That's normal: type the one showing now.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Lost your phone, or got a new one? Ask a Super User to reset your authenticator. You'll get an email to set it up again.
        </Paragraph>
        <a onClick={() => { setStep('password'); setError(null); }}>Back to sign in</a>
      </Shell>
    );
  }

  if (step === 'setup' && setup) {
    const stepTitle = (n: number, t: string) => <Text strong style={{ display: 'block', marginBottom: 6 }}>{n}. {t}</Text>;
    return (
      <Shell
        width={520}
        title="Connect your phone"
        subtitle="Last step. Each time you sign in to PipeLine you'll also type a 6-digit number from an app on your phone. Let's set that up. It takes a few minutes."
      >
        <div style={{ marginBottom: 20 }}>
          {stepTitle(1, 'Get an authenticator app')}
          <Paragraph style={{ marginBottom: 0 }}>
            On your phone, open the <strong>App Store</strong> (iPhone) or <strong>Google Play</strong> (Android). Search for{' '}
            <strong>authenticator</strong> and install a free one, such as <strong>Google Authenticator</strong> or{' '}
            <strong>Microsoft Authenticator</strong>. Already have one? Use it.
          </Paragraph>
        </div>
        <div style={{ marginBottom: 20 }}>
          {stepTitle(2, 'Add PipeLine to the app')}
          <Paragraph>
            Open the app and tap the <strong>+</strong> (plus) button. Choose <strong>Scan a QR code</strong> and point your phone's camera at this square:
          </Paragraph>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
              alt="QR code to scan with your authenticator app"
              width={208}
              height={208}
              style={{ border: '1px solid #f0f0f0', borderRadius: 6, background: '#fff' }}
            />
          </div>
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            message={<span><strong>On your phone right now?</strong> You can't scan your own screen. Install the app first, then tap this button instead:</span>}
            description={<Button href={setup.uri} block style={{ marginTop: 8 }}>Add PipeLine to my authenticator app</Button>}
          />
          <Collapse
            size="small"
            items={[{
              key: 'key',
              label: "Can't scan it? Type a key instead",
              children: (
                <div>
                  <Paragraph>
                    In the app, choose <strong>Enter a setup key</strong> (some apps say <strong>Enter code manually</strong>). For the account name, type{' '}
                    <strong>PipeLine</strong>. For the key, type these letters and numbers (the spaces don't matter):
                  </Paragraph>
                  <Paragraph copyable={{ text: setup.key.replace(/\s/g, '') }} style={{ fontFamily: 'monospace', fontSize: 16, textAlign: 'center', background: '#fafafa', padding: 8, borderRadius: 4 }}>
                    {setup.key}
                  </Paragraph>
                  <Paragraph style={{ marginBottom: 0 }}>If the app asks, choose <strong>Time based</strong>.</Paragraph>
                </div>
              ),
            }]}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          {stepTitle(3, 'Type the number the app shows')}
          <Paragraph>The app now shows <strong>PipeLine</strong> with a 6-digit number that changes every 30 seconds. Type the number showing now.</Paragraph>
          <CodeForm button="Finish" onDone={done} onRestart={restart} />
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Keep the app on your phone. If you get a new phone, ask a Super User to reset your authenticator.
        </Text>
      </Shell>
    );
  }

  return (
    <Shell title="Sign in">
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      {notice && <Alert type="success" message={notice} style={{ marginBottom: 16 }} />}
      <Form layout="vertical" onFinish={onPassword}>
        <Form.Item name="email" label="Email" rules={[{ required: true }]}>
          <Input autoFocus autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting} block>Next</Button>
      </Form>
    </Shell>
  );
}
