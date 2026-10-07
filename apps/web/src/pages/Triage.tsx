// Destination: apps/web/src/pages/Triage.tsx  (NEW FILE)
//
// ASSUMPTION TO VERIFY: this assumes your page-level components still live in
// apps/web/src/pages/ (that's where Dashboard.tsx etc. lived in the original
// setup doc). Confirm against your actual current folder layout — if Groups/
// Carriers/Products live somewhere else now, drop this file there instead.
//
// Deliberately self-contained (own state, no shared MaintenancePage plumbing)
// since this is meant to be temporary and easy to delete: one file + one
// route line in App.tsx, nothing threaded through the shared Databases-screen
// pattern. Posts to /api/triage (the new Node passthrough -> Bucket's
// /triage route). Not tied to any Group or Deal.

import { useState } from 'react';
import { Upload, Table, Typography, Alert } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';

const { Dragger } = Upload;
const { Title, Paragraph } = Typography;

interface TriageProduct {
  product_label: string;
  rates_present: boolean | null;
  rate_type: 'simple_tiered' | 'age_banded' | 'not_applicable' | 'unclear' | null;
}

interface TriageProfileMatch {
  matched: boolean;
  profile_file: string | null;
  profile_carrier_name: string | null;
}

interface TriageResult {
  key: string;
  filename: string;
  status: 'working' | 'done' | 'error';
  error?: string;
  is_multi_product?: boolean;
  carrier_name?: string;
  products?: TriageProduct[];
  profile_matches?: Record<string, TriageProfileMatch>;
  notes?: string;
}

function summarizeMatches(pm?: Record<string, TriageProfileMatch>): string {
  if (!pm) return '';
  const hits = Object.entries(pm)
    .filter(([, v]) => v.matched)
    .map(([pt, v]) => `${pt}: ${v.profile_file}`);
  return hits.length ? hits.join(', ') : 'no match (either type)';
}

export default function Triage() {
  const [rows, setRows] = useState<TriageResult[]>([]);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: true,
    accept: 'application/pdf',
    showUploadList: false,
    customRequest: async (options) => {
      const file = options.file as File;
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setRows((prev) => [{ key, filename: file.name, status: 'working' }, ...prev]);

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/triage', { method: 'POST', body: formData });
        const body = await res.json();

        if (!res.ok) {
          setRows((prev) =>
            prev.map((r) => (r.key === key ? { ...r, status: 'error', error: body.error || 'Failed' } : r))
          );
          options.onError?.(new Error(body.error || 'Failed'));
          return;
        }

        const c = body.classification || {};
        setRows((prev) =>
          prev.map((r) =>
            r.key === key
              ? {
                  ...r,
                  status: 'done',
                  is_multi_product: c.is_multi_product,
                  carrier_name: c.carrier_name,
                  products: c.products,
                  profile_matches: body.profile_matches,
                  notes: c.notes,
                }
              : r
          )
        );
        options.onSuccess?.(body);
      } catch (err: any) {
        setRows((prev) =>
          prev.map((r) => (r.key === key ? { ...r, status: 'error', error: err.message } : r))
        );
        options.onError?.(err);
      }
    },
  };

  // One table row per product, so a multi-product document renders as several
  // rows. Not bothering with rowSpan grouping — plain repetition is simplest
  // and correct, this is a throwaway diagnostic table, not a polished UI.
  const flatRows = rows.flatMap((r) => {
    if (r.status !== 'done') {
      return [
        {
          key: r.key,
          filename: r.filename,
          multi: r.status === 'working' ? 'working…' : 'error',
          carrier: r.status === 'error' ? r.error : '',
          product: '',
          ratesPresent: '',
          rateType: '',
          matchedProfile: '',
          notes: '',
        },
      ];
    }
    const products = r.products?.length
      ? r.products
      : [{ product_label: '(none reported)', rates_present: null, rate_type: null }];
    return products.map((p, i) => ({
      key: `${r.key}-${i}`,
      filename: i === 0 ? r.filename : '',
      multi: i === 0 ? (r.is_multi_product ? 'Multi' : 'Single') : '',
      carrier: i === 0 ? r.carrier_name : '',
      product: p.product_label,
      ratesPresent: p.rates_present === true ? 'Y' : p.rates_present === false ? 'N' : '?',
      rateType: p.rate_type === 'not_applicable' ? 'N/A' : p.rate_type ?? '?',
      matchedProfile: i === 0 ? summarizeMatches(r.profile_matches) : '',
      notes: i === 0 ? r.notes : '',
    }));
  });

  const columns = [
    { title: 'File', dataIndex: 'filename', key: 'filename' },
    { title: 'Multi?', dataIndex: 'multi', key: 'multi' },
    { title: 'Carrier', dataIndex: 'carrier', key: 'carrier' },
    { title: 'Product', dataIndex: 'product', key: 'product' },
    { title: 'Rates?', dataIndex: 'ratesPresent', key: 'ratesPresent' },
    { title: 'Rate Type', dataIndex: 'rateType', key: 'rateType' },
    { title: 'Matched Profile', dataIndex: 'matchedProfile', key: 'matchedProfile' },
    { title: 'Notes', dataIndex: 'notes', key: 'notes' },
  ];

  return (
    <div style={{ background: '#fff', padding: 24, minHeight: 360 }}>
      <Title level={3}>Triage (temporary)</Title>
      <Paragraph type="secondary">
        Drop PDFs here to see what the system thinks they are — no product type needed,
        nothing gets saved as a real quote or carrier profile. Built to shake out edge
        cases before the multi-product / benefit-line rework.
      </Paragraph>

      <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        message="Temporary page — safe to delete (this file, its route line, and apps/api/src/routes/triage.ts) once it's served its purpose."
      />

      <Dragger {...uploadProps} style={{ marginBottom: 24 }}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">Click or drag PDFs here (one or many)</p>
      </Dragger>

      <Table columns={columns} dataSource={flatRows} pagination={false} size="small" />
    </div>
  );
}
