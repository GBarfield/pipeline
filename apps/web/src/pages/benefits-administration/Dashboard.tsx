import { Typography, Empty } from 'antd';

const { Title } = Typography;

// Placeholder landing page for the Benefits Administration division. Wired
// up as the real route target for /benefits-administration/dashboard so
// division switching has somewhere correct to land - fill in real
// widgets/stats here later.
export default function BenefitsAdministrationDashboard() {
  return (
    <div>
      <Title level={3}>Benefits Administration Dashboard</Title>
      <Empty description="Coming soon" />
    </div>
  );
}
