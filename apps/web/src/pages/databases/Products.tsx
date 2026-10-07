// Destination: apps/web/src/pages/databases/Products.tsx
import MaintenancePage from '../../components/MaintenancePage';
import type { FieldConfig } from '../../components/MaintenancePage';

const fields: FieldConfig[] = [
  {
    name: 'carrierId',
    label: 'Carrier',
    type: 'relation',
    required: true,
    relationApi: '/api/carriers',
    relationLabelKey: 'name',
  },
  { name: 'name', label: 'Product Name', type: 'text', required: true },
  { name: 'productType', label: 'Product Type', type: 'text' },
  { name: 'description', label: 'Description', type: 'textarea', span: 24 },
  { name: 'active', label: 'Active', type: 'switch' },
];

export default function Products() {
  return (
        <MaintenancePage
      title="Products"
      apiBase="/api/products"
      fields={fields}
      labelFor={(r) => (r.carrier ? `${r.name} (${r.carrier.name})` : r.name)}
      writeRoles={['SUPER_USER']}
    />
  );
}
