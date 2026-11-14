// Destination: apps/web/src/components/ContactsDirectory.tsx
//
// Read-only, searchable list of every active CarrierContact across all
// Carrier rows of the given partnerType(s), from GET /api/partner-contacts.
// Used on both the Carriers page (types="CARRIER") and the TPAs & Vendors
// page (types="TPA,VENDOR" / "TPA" / "VENDOR"). Contacts are edited in the
// per-company Contacts panel on the Manage tab, not here.
import { useEffect, useMemo, useState } from 'react';
import { Table, Input, Tag, Space, Typography, message } from 'antd';

export const TYPE_TAG: Record<string, { color: string; label: string }> = {
  CARRIER: { color: 'blue', label: 'Carrier' },
  TPA: { color: 'purple', label: 'TPA' },
  VENDOR: { color: 'geekblue', label: 'Vendor' },
};

interface DirectoryRow {
  id: number;
  name: string;
  title: string | null;
  email: string;
  phone: string | null;
  carrier: { id: number; name: string; partnerType: string; active: boolean };
}

const API_ROOT = import.meta.env.VITE_API_URL ?? '';

export default function ContactsDirectory({ types }: { types: string }) {
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`${API_ROOT}/api/partner-contacts?type=${encodeURIComponent(types)}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setRows)
      .catch(() => message.error('Could not load contacts'))
      .finally(() => setLoading(false));
  }, [types]);

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
            hidden: !types.includes(','),
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

