// Destination: apps/web/src/pages/databases/Brokers.tsx
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';

const fields: FieldConfig[] = [
  { name: 'companyName', label: 'Company Name', type: 'text', required: true, span: 24 },
  { name: 'firstName', label: 'Owner/Manager First Name', type: 'text', required: true },
  { name: 'lastName', label: 'Owner/Manager Last Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'phone', label: 'Phone', type: 'text' },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'address2', label: 'Address 2', type: 'text' },
  { name: 'city', label: 'City', type: 'text' },
  { name: 'state', label: 'State', type: 'text' },
  { name: 'zip', label: 'ZIP', type: 'text' },
  { name: 'brokerType', label: 'Broker Type', type: 'text' },
  {
    name: 'carrierId',
    label: 'Affiliated Carrier',
    type: 'relation',
    relationApi: '/api/carriers',
    relationLabelKey: 'name',
  },
  { name: 'isHouseAccount', label: 'House Account', type: 'switch' },
  { name: 'archived', label: 'Archived', type: 'switch' },
];

export default function Brokers() {
  return (
     <MaintenancePage
      title="Brokers"
      apiBase="/api/brokers"
      fields={fields}
      labelFor={(r) => (r.companyName ? `${r.companyName} (${r.firstName} ${r.lastName})` : `${r.firstName} ${r.lastName}`)}
      writeRoles={['SUPER_USER']}
    />
  );
}
