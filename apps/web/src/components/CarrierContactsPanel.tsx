// Destination: apps/web/src/components/CarrierContactsPanel.tsx
import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Switch, Space, message, Popconfirm } from 'antd';

interface CarrierContact {
  id: number;
  name: string;
  title: string | null;
  email: string;
  phone: string | null;
  active: boolean;
}

const API_ROOT = import.meta.env.VITE_API_URL ?? '';

export default function CarrierContactsPanel({ carrierId }: { carrierId: number }) {
  const [contacts, setContacts] = useState<CarrierContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CarrierContact | null>(null);
  const [form] = Form.useForm();

  const url = `${API_ROOT}/api/carriers/${carrierId}/contacts`;

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(url);
      setContacts(await res.json());
    } catch {
      message.error('Could not load contacts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrierId]);

  const openNew = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (contact: CarrierContact) => {
    setEditing(contact);
    form.setFieldsValue(contact);
    setModalOpen(true);
  };

  const handleSubmit = async (values: Partial<CarrierContact>) => {
    try {
      const res = await fetch(editing ? `${url}/${editing.id}` : url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Save failed');
      message.success('Contact saved');
      setModalOpen(false);
      load();
    } catch {
      message.error('Save failed');
    }
  };

  const handleRemove = async (id: number) => {
    try {
      await fetch(`${url}/${id}`, { method: 'DELETE' });
      message.success('Contact removed');
      load();
    } catch {
      message.error('Remove failed');
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button onClick={openNew}>+ New Contact</Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={contacts}
        pagination={false}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Title', dataIndex: 'title' },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Phone', dataIndex: 'phone' },
          {
            title: '',
            key: 'actions',
            render: (_, record: CarrierContact) => (
              <Space>
                <Button size="small" onClick={() => openEdit(record)}>Edit</Button>
                <Popconfirm title="Remove this contact?" onConfirm={() => handleRemove(record.id)}>
                  <Button size="small" danger>Remove</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? 'Edit Contact' : 'New Contact'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="title" label="Title">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          {editing && (
            <Form.Item name="active" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}