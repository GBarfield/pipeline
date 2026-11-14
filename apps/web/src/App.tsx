import { Layout, Menu, Avatar, Dropdown, Spin, type MenuProps } from 'antd';
import type { ReactNode } from 'react';
import {
  DashboardOutlined,
  SettingOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  TeamOutlined,
  UserOutlined,
  LogoutOutlined,
  AuditOutlined,
  MailOutlined,
} from '@ant-design/icons';
import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import AccountingDashboard from './pages/accounting/Dashboard';
import BenefitsAdministrationDashboard from './pages/benefits-administration/Dashboard';
import Settings from './pages/Settings';
import Carriers from './pages/databases/Carriers';
import Partners from './pages/databases/Partners';
import Brokers from './pages/databases/Brokers';
import Products from './pages/databases/Products';
import Groups from './pages/databases/Groups';
import Triage from './pages/Triage';
import Login from './pages/Login';
import Users from './pages/Users';
import { AuthProvider, useAuth, type AuthUser } from './context/AuthContext';
import { DivisionProvider, useDivision, getDashboardPath } from './context/DivisionContext';
import { DivisionSwitcher } from './components/DivisionSwitcher';
import CommissionReconciliation from './pages/accounting/CommissionReconciliation';
import BenefitsAdministrationReconciliation from './pages/benefits-administration/Reconciliation';
import CarrierCommunication from './pages/benefits-administration/CarrierCommunication';

const { Sider, Content, Header } = Layout;

interface MenuEntry {
  key: string;
  icon?: ReactNode;
  label: ReactNode;
  roles?: AuthUser['role'][]; // omit = visible to every logged-in role
  divisions?: string[]; // omit = visible in every division; otherwise a list of Division.key values
  children?: MenuEntry[];
}

// The Dashboard entry's target depends on which division is active, so the
// menu is now built per-render instead of being one flat static constant.
function buildMenuItems(divisionKey: string | null): MenuEntry[] {
  const dashboardPath = getDashboardPath(divisionKey);
  return [
    { key: dashboardPath, icon: <DashboardOutlined />, label: <Link to={dashboardPath}>Dashboard</Link> },
    {
      key: '/databases',
      icon: <DatabaseOutlined />,
      label: 'Databases',
      children: [
        { key: '/databases/carriers', label: <Link to="/databases/carriers">Carriers</Link> },
        { key: '/databases/partners', label: <Link to="/databases/partners">TPAs & Vendors</Link> },
        { key: '/databases/brokers', label: <Link to="/databases/brokers">Brokers</Link> },
        { key: '/databases/products', label: <Link to="/databases/products">Products</Link> },
        { key: '/databases/groups', label: <Link to="/databases/groups">Groups</Link> },
      ],
    },
    {
      key: '/accounting/commission-reconciliation',
      icon: <AuditOutlined />,
      label: <Link to="/accounting/commission-reconciliation">Commission Reconciliation</Link>,
      divisions: ['ACCOUNTING'],
    },
    {
      key: '/benefits-administration/reconciliation',
      icon: <AuditOutlined />,
      label: <Link to="/benefits-administration/reconciliation">Reconciliation</Link>,
      divisions: ['BENEFITS_ADMINISTRATION'],
    },
    {
      key: '/benefits-administration/carrier-communication',
      icon: <MailOutlined />,
      label: <Link to="/benefits-administration/carrier-communication">Carrier Communication</Link>,
      divisions: ['BENEFITS_ADMINISTRATION'],
    },
    { key: '/triage', icon: <ExperimentOutlined />, label: <Link to="/triage">Triage</Link> },
    { key: '/users', icon: <TeamOutlined />, label: <Link to="/users">Users</Link>, roles: ['SUPER_USER'] },
    { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">Settings</Link> },
  ];
}

function filterMenu(items: MenuEntry[], role: AuthUser['role'], divisionKey: string | null): MenuEntry[] {
  return items
    .filter((item) => !item.roles || item.roles.includes(role))
    .filter((item) => !item.divisions || (divisionKey !== null && item.divisions.includes(divisionKey)))
    .map((item) => (item.children ? { ...item, children: filterMenu(item.children, role, divisionKey) } : item));
}

// Landing target for "/" - always sends the user on to whichever division's
// dashboard is currently active, so a bare "/" (an old bookmark, a fresh
// login, a stale link) never strands anyone on the wrong division's page.
function DashboardRedirect() {
  const { currentDivision, loading } = useDivision();

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '200px', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  return <Navigate to={getDashboardPath(currentDivision?.key ?? null)} replace />;
}

function Shell({ user }: { user: AuthUser }) {
  const location = useLocation();
  const { logout } = useAuth();
  const { currentDivision } = useDivision();
  const menuItems = filterMenu(buildMenuItems(currentDivision?.key ?? null), user.role, currentDivision?.key ?? null);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={220}>
        <div style={{ color: '#fff', padding: '16px', fontSize: '18px', fontWeight: 600 }}>
          PipeLine
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          defaultOpenKeys={location.pathname.startsWith('/databases') ? ['/databases'] : []}
          items={menuItems as MenuProps['items']}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
         <DivisionSwitcher />
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Log out', onClick: () => logout() }],
            }}
          >
            <span style={{ cursor: 'pointer' }}>
              <Avatar size="small" icon={<UserOutlined />} style={{ marginRight: 8 }} />
              {user.name}
            </span>
          </Dropdown>
        </Header>
        <Content style={{ margin: '24px' }}>
          <Routes>
            <Route path="/" element={<DashboardRedirect />} />
            <Route path="/marketing/dashboard" element={<Dashboard />} />
            <Route path="/accounting/dashboard" element={<AccountingDashboard />} />
            <Route path="/benefits-administration/dashboard" element={<BenefitsAdministrationDashboard />} />
            <Route path="/databases/carriers" element={<Carriers />} />
            <Route path="/databases/partners" element={<Partners />} />
            <Route path="/databases/brokers" element={<Brokers />} />
            <Route path="/databases/products" element={<Products />} />
            <Route path="/databases/groups" element={<Groups />} />
            <Route path="/accounting/commission-reconciliation" element={<CommissionReconciliation />} />
            <Route path="/benefits-administration/reconciliation" element={<BenefitsAdministrationReconciliation />} />
            <Route path="/benefits-administration/carrier-communication" element={<CarrierCommunication />} />
            <Route path="/triage" element={<Triage />} />
            {user.role === 'SUPER_USER' && <Route path="/users" element={<Users />} />}
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

// Shows a spinner while the initial /api/auth/me check is in flight, the
// Login form if there's no session, or the real app shell once logged in.
// Deliberately not a react-router <Route path="/login"> - rendering Login
// "in place" like this means whatever URL was already in the address bar
// (including a bookmarked deep link) is exactly where the user lands right
// after authenticating, with no redirect step to get wrong.
function AuthGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <DivisionProvider>
      <Shell user={user} />
    </DivisionProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
