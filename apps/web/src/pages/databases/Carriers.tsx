// Destination: apps/web/src/pages/databases/Carriers.tsx
import { Tabs } from 'antd';
import MaintenancePage from '../../components/MaintenancePage';
import ContactsDirectory from '../../components/ContactsDirectory';
import type { FieldConfig } from '../../components/MaintenancePage';
import CarrierContactsPanel from '../../components/CarrierContactsPanel';
import { PARTNER_TYPE_OPTIONS } from './partnerTypes';

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
  // Switch a row to TPA / Vendor here to move it onto the TPAs & Vendors page.
  { name: 'partnerType', label: 'Type', type: 'select', required: true, options: PARTNER_TYPE_OPTIONS },
  { name: 'logoImage', label: 'Logo Image URL', type: 'text', span: 24 },
  { name: 'active', label: 'Active', type: 'switch' },
];

// Two tabs, matching the TPAs & Vendors page:
//   - Manage (default): select/edit a carrier. Its contacts are in the
//     Contacts panel at the bottom, which shows once a carrier is selected.
//   - Contacts Directory: every carrier contact in one searchable table.
export default function Carriers() {
  return (
    <Tabs
      defaultActiveKey="manage"
      items={[
        {
          key: 'manage',
          label: 'Manage',
          children: (
            <MaintenancePage
              title="Carriers"
              apiBase="/api/carriers"
              fields={fields}
              labelFor={(r) => r.name}
              writeRoles={['SUPER_USER']}
              defaults={{ partnerType: 'CARRIER' }}
              accordion={{ selectLabel: 'Select Carrier', formLabel: 'Carrier Details' }}
              extraPanels={(record) => [
                {
                  key: 'contacts',
                  label: 'Contacts',
                  children: <CarrierContactsPanel carrierId={record.id} />,
                },
              ]}
            />
          ),
        },
        { key: 'directory', label: 'Contacts Directory', children: <ContactsDirectory types="CARRIER" /> },
      ]}
    />
  );
}
