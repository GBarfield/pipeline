// Destination: apps/web/src/pages/databases/Carriers.tsx
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';
import CarrierContactsPanel from '../../components/CarrierContactsPanel';

const fields: FieldConfig[] = [
  { name: 'name', label: 'Carrier Name', type: 'text', required: true },
  { name: 'contactFirstName', label: 'Contact First Name', type: 'text' },
  { name: 'contactLastName', label: 'Contact Last Name', type: 'text' },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'city', label: 'City', type: 'text' },
  { name: 'state', label: 'State', type: 'text' },
  { name: 'zip', label: 'ZIP', type: 'text' },
  { name: 'phone', label: 'Phone', type: 'text' },
  { name: 'email', label: 'Email', type: 'text' },
  { name: 'specialty', label: 'Specialty', type: 'text' },
  { name: 'logoImage', label: 'Logo Image URL', type: 'text', span: 24 },
  { name: 'active', label: 'Active', type: 'switch' },
];

export default function Carriers() {
  return (
    <MaintenancePage
      title="Carriers"
      apiBase="/api/carriers"
      fields={fields}
      labelFor={(r) => r.name}
      writeRoles={['SUPER_USER']}
      accordion={{ selectLabel: 'Select Carrier', formLabel: 'Carrier Details' }}
      extraPanels={(record) => [
        {
          key: 'contacts',
          label: 'Contacts',
          children: <CarrierContactsPanel carrierId={record.id} />,
        },
      ]}
    />
  );
}
