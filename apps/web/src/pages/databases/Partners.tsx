// Destination: apps/web/src/pages/databases/Partners.tsx
//
// TPAs & Vendors: Carrier rows whose partnerType is TPA or VENDOR. Same
// table and same CarrierContact sub-table as Carriers, kept on their own
// page so they never clutter carrier pickers. GET /api/carriers returns
// CARRIER rows only unless ?type= is passed.
//
// Two tabs:
//   - Contacts Directory: every active contact across all TPAs/vendors in
//     one searchable table (components/ContactsDirectory). Read-only.
//   - Manage: the usual MaintenancePage select/edit form plus the
//     per-partner Contacts panel, where contacts are added and edited.
// Same permissions as Carriers: the company record itself is Super-User
// write only, while contacts are editable by any role.
import { useState } from 'react';
import { Tabs, Segmented, Space, Typography } from 'antd';
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';
import CarrierContactsPanel from '../../components/CarrierContactsPanel';
import { PARTNER_TYPE_OPTIONS } from './partnerTypes';
import ContactsDirectory, { TYPE_TAG } from '../../components/ContactsDirectory';


type Filter = 'TPA,VENDOR' | 'TPA' | 'VENDOR';

const fields: FieldConfig[] = [
  { name: 'name', label: 'Company Name', type: 'text', required: true },
  { name: 'partnerType', label: 'Type', type: 'select', required: true, options: PARTNER_TYPE_OPTIONS },
  { name: 'specialty', label: 'Services (e.g. COBRA, FSA/HSA, Quoting)', type: 'text' },
  { name: 'contactFirstName', label: 'Main Contact First Name', type: 'text' },
  { name: 'contactLastName', label: 'Main Contact Last Name', type: 'text' },
  { name: 'phone', label: 'Main Phone', type: 'text' },
  { name: 'email', label: 'Main Email', type: 'text' },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'city', label: 'City', type: 'text' },
  { name: 'state', label: 'State', type: 'text' },
  { name: 'zip', label: 'ZIP', type: 'text' },
  { name: 'active', label: 'Active', type: 'switch' },
];

export default function Partners() {
  const [filter, setFilter] = useState<Filter>('TPA,VENDOR');

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space align="center" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          TPAs &amp; Vendors
        </Typography.Title>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'TPA,VENDOR', label: 'All' },
            { value: 'TPA', label: 'TPAs / Administrators' },
            { value: 'VENDOR', label: 'Software Vendors' },
          ]}
        />
      </Space>
      <Tabs
        defaultActiveKey="directory"
        items={[
          { key: 'directory', label: 'Contacts Directory', children: <ContactsDirectory types={filter} /> },
          {
            key: 'manage',
            label: 'Manage',
            children: (
              <MaintenancePage
                title="Partners"
                apiBase="/api/carriers"
                listQuery={`?type=${filter}`}
                fields={fields}
                labelFor={(r) => `${r.name} (${TYPE_TAG[r.partnerType]?.label ?? r.partnerType})`}
                writeRoles={['SUPER_USER']}
                defaults={{ partnerType: filter === 'VENDOR' ? 'VENDOR' : 'TPA' }}
                accordion={{ selectLabel: 'Select TPA / Vendor', formLabel: 'Company Details' }}
                extraPanels={(record) => [
                  { key: 'contacts', label: 'Contacts', children: <CarrierContactsPanel carrierId={record.id} /> },
                ]}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}
