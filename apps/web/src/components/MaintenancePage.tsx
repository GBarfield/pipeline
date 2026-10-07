// Destination: apps/web/src/components/MaintenancePage.tsx
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Select,
  Form,
  Input,
  InputNumber,
  DatePicker,
  Switch,
  Button,
  Card,
  Space,
  message,
  Divider,
  Collapse,
} from 'antd';
import dayjs from 'dayjs';

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'switch' | 'relation';

export interface FieldConfig {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  span?: number;
  relationApi?: string;
  relationLabelKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relationLabel?: (record: any) => string;
}

interface RecordOption {
  id: number;
  label: string;
}

export interface AccordionPanelLabels {
  selectLabel: string;
  formLabel: string;
}

export interface ExtraPanel {
  key: string;
  label: string;
  children: ReactNode;
}

export interface MaintenancePageProps {
  title: string;
  apiBase: string;
  fields: FieldConfig[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labelFor: (record: any) => string;
  accordion?: AccordionPanelLabels;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraPanels?: (record: any) => ExtraPanel[];
  // Roles allowed to create/edit records on this page, mirroring the
  // backend's own `writeRoles` option on crudFactory (Auth doc section 4/6).
  // Omit entirely for a page where every authenticated role can write
  // (e.g. Groups) -- default is "no restriction," so existing callers of
  // this component are unaffected.
  writeRoles?: Array<'SUPER_USER' | 'BROKER_USER'>;
}

const API_ROOT = import.meta.env.VITE_API_URL ?? '';

export default function MaintenancePage({
  title,
  apiBase,
  fields,
  labelFor,
  accordion,
  extraPanels,
  writeRoles,
}: MaintenancePageProps) {
  const { user } = useAuth();
  const canWrite = !writeRoles || (!!user && writeRoles.includes(user.role));
  const [form] = Form.useForm();
  const [options, setOptions] = useState<RecordOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [relationOptions, setRelationOptions] = useState<Record<string, RecordOption[]>>({});

  const url = `${API_ROOT}${apiBase}`;
  const singular = title.endsWith('s') ? title.slice(0, -1) : title;

  const loadOptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url);
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setOptions(data.map((r: any) => ({ id: r.id, label: labelFor(r) })));
    } catch {
      message.error(`Could not load ${title}`);
    } finally {
      setLoading(false);
    }
  }, [url, title, labelFor]);

  useEffect(() => {
    loadOptions();

    fields
      .filter((f) => f.type === 'relation' && f.relationApi)
      .forEach(async (f) => {
        try {
          const res = await fetch(`${API_ROOT}${f.relationApi}`);
          const data = await res.json();
          setRelationOptions((prev) => ({
            ...prev,
            [f.name]: data.map((r: any) => ({
              id: r.id,
              label: f.relationLabel ? f.relationLabel(r) : r[f.relationLabelKey || 'name'],
            })),
          }));
        } catch {
          message.error(`Could not load options for ${f.label}`);
        }
      });
    // only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = async (id: number) => {
    setSelectedId(id);
    setLoading(true);
    try {
      const res = await fetch(`${url}/${id}`);
      const record = await res.json();
      setSelectedRecord(record);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values: any = { ...record };
      fields.forEach((f) => {
        if (f.type === 'date' && values[f.name]) {
          values[f.name] = dayjs(values[f.name]);
        }
      });
      form.setFieldsValue(values);
    } catch {
      message.error('Could not load record');
    } finally {
      setLoading(false);
    }
  };

  const handleNew = () => {
    setSelectedId(null);
    setSelectedRecord(null);
    form.resetFields();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSubmit = async (values: any) => {
    setSaving(true);
    const payload = { ...values };
    fields.forEach((f) => {
      if (f.type === 'date' && payload[f.name]) {
        payload[f.name] = payload[f.name].toISOString();
      }
    });
    try {
      const res = await fetch(selectedId ? `${url}/${selectedId}` : url, {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Save failed');
      const saved = await res.json();
      message.success(`${singular} saved`);
      setSelectedId(saved.id);
      setSelectedRecord(saved);
      loadOptions();
    } catch {
      message.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const selectContent = (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select
        showSearch
        allowClear
        placeholder={`Search ${title.toLowerCase()}...`}
        style={{ width: 400 }}
        loading={loading}
        value={selectedId ?? undefined}
        onChange={(val) => (val ? handleSelect(val) : handleNew())}
        filterOption={(input, option) =>
          (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
        }
        options={options.map((o) => ({ value: o.id, label: o.label }))}
      />
            {canWrite && <Button onClick={handleNew}>+ New Entry</Button>}
    </Space>
  );

  const formContent = (
    <Form form={form} layout="vertical" onFinish={handleSubmit} disabled={!canWrite}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 24px' }}>
        {fields.map((f) => (
          <Form.Item
            key={f.name}
            name={f.name}
            label={f.label}
            rules={f.required ? [{ required: true, message: `${f.label} is required` }] : []}
            style={{ width: f.span === 24 ? '100%' : 320 }}
            valuePropName={f.type === 'switch' ? 'checked' : 'value'}
          >
            {renderField(f, relationOptions[f.name])}
          </Form.Item>
        ))}
      </div>
      <Divider />
      {canWrite && (
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>
            {selectedId ? 'Save Changes' : 'Create Entry'}
          </Button>
          {selectedId && <Button onClick={handleNew}>Clear / New</Button>}
        </Space>
      )}
    </Form>
  );

  if (accordion) {
    const panels = [
      { key: '__select', label: accordion.selectLabel, children: selectContent },
      { key: '__form', label: accordion.formLabel, children: formContent },
      ...(selectedRecord && extraPanels ? extraPanels(selectedRecord) : []),
    ];

    return <Collapse defaultActiveKey={['__select', '__form']} items={panels} />;
  }

  return (
    <div>
      <Card title={`Select ${title}`} style={{ marginBottom: 24 }}>
        {selectContent}
      </Card>

      <Card title={selectedId ? `Edit ${singular}` : `New ${singular}`}>
        {formContent}
      </Card>
    </div>
  );
}

function renderField(f: FieldConfig, relationOpts?: RecordOption[]) {
  switch (f.type) {
    case 'textarea':
      return <Input.TextArea rows={3} />;
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'date':
      return <DatePicker style={{ width: '100%' }} />;
    case 'switch':
      return <Switch />;
    case 'relation':
      return (
        <Select
          showSearch
          allowClear
          placeholder={`Select ${f.label}`}
          filterOption={(input, option) =>
            (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
          }
          options={(relationOpts || []).map((o) => ({ value: o.id, label: o.label }))}
        />
      );
    default:
      return <Input />;
  }
}