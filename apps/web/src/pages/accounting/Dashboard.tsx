import { Typography, Empty } from 'antd';

const { Title } = Typography;

// Placeholder landing page for the Accounting division. Wired up as the
// real route target for /accounting/dashboard so division switching has
// somewhere correct to land - fill in real widgets/stats here later.
export default function AccountingDashboard() {
  return (
    <div>
      <Title level={3}>Accounting Dashboard</Title>
      <Empty description="Coming soon" />
    </div>
  );
}
