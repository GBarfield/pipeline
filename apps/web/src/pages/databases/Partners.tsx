// Destination: apps/web/src/pages/databases/Partners.tsx
//
// TPAs & Vendors: Carrier rows whose partnerType is TPA or VENDOR. Same
// table and same CarrierContact sub-table as Carriers, kept on their own
// page so they never clutter carrier pickers. GET /api/carriers returns
// CARRIER rows only unless ?type= is passed.
//
// Two tabs:
//   - Contacts Directory: every active contact across all TPAs/vendors in
//     one searchable table (GET /api/partner-contacts). Read-only.
//   - Manage: the usual MaintenancePage select/edit form plus the
//     per-partner Contacts panel, where contacts are added and edited.
// Same permissions as Carriers: the company record itself is Super-User
// write only, while contacts are editable by any role.
import { useEffect, useMemo, useState } from 'react';
import { Tabs, Table, Input, Segmented, Tag, Space, Typography, message } from 'antd';
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';
import CarrierContactsPanel from '../../components/CarrierContactsPanel';
import { PARTNER_TYPE_OPTIONS } from './partnerTypes';


const TYPE_TAG: Record<string, { color: string; label: string }> = {
  CARRIER: { color: 'blue', label: 'Carrier' },
  TPA: { color: 'purple', label: 'TPA' },
  VENDOR: { color: 'geekblue', label: 'Vendor' },
};

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

interface DirectoryRow {
  id: number;
  name: string;
  title: string | null;
  email: string;
  phone: string | null;
  carrier: { id: number; name: string; partnerType: string; active: boolean };
}

const API_ROOT = import.meta.env.VITE_API_URL ?? '';

function ContactsDirectory({ filter }: { filter: Filter }) {
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`${API_ROOT}/api/partner-contacts?type=${filter}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setRows)
      .catch(() => message.error('Could not load contacts'))
      .finally(() => setLoading(false));
  }, [filter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.carrier.name, r.name, r.title, r.email, r.phone].some((v) => v && v.toLowerCase().includes(q))
    );
  }, [rows, search]);

  const companies = new Set(filtered.map((r) => r.carrier.id)).size;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Search company, contact, title, email..."
          style={{ width: 380 }}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Typography.Text type="secondary">
          {filtered.length} contact{filtered.length === 1 ? '' : 's'} at {companies} compan{companies === 1 ? 'y' : 'ies'}
        </Typography.Text>
      </Space>
      <Table<DirectoryRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={filtered}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        columns={[
          {
            title: 'Company',
            key: 'company',
            sorter: (a, b) => a.carrier.name.localeCompare(b.carrier.name),
            defaultSortOrder: 'ascend',
            render: (_, r) => (
              <Space size={4}>
                {r.carrier.name}
                {!r.carrier.active && <Tag>Inactive</Tag>}
              </Space>
            ),
          },
          {
            title: 'Type',
            key: 'type',
            width: 90,
            render: (_, r) => {
              const t = TYPE_TAG[r.carrier.partnerType];
              return t ? <Tag color={t.color}>{t.label}</Tag> : r.carrier.partnerType;
            },
          },
          { title: 'Contact', dataIndex: 'name', sorter: (a, b) => a.name.localeCompare(b.name) },
          { title: 'Handles', dataIndex: 'title', ellipsis: true },
          {
            title: 'Email',
            dataIndex: 'email',
            render: (email: string) => (
              <Typography.Text copyable={{ text: email }}>
                <a href={`mailto:${email}`}>{email}</a>
              </Typography.Text>
            ),
          },
          { title: 'Phone', dataIndex: 'phone', width: 150 },
        ]}
      />
    </Space>
  );
}

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
          { key: 'directory', label: 'Contacts Directory', children: <ContactsDirectory filter={filter} /> },
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
