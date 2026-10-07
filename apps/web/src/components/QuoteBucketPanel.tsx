// Destination: apps/web/src/components/QuoteBucketPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Select, Upload, Table, Tag, Button, Form, Input, Modal, message, Popconfirm, Space, Spin, Alert, List, Divider, Checkbox, Tooltip } from 'antd';
import { InboxOutlined, LoadingOutlined, DeleteOutlined, RedoOutlined, FormOutlined, UploadOutlined, EyeOutlined, DownloadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';

const CARRIER_NAME_MAX = 20;

const { Dragger } = Upload;

const POLL_INTERVAL_MS = 3000;

const RATE_TYPE_OPTIONS = [
  { label: 'Simple Tiered', value: 'simple_tiered' },
  { label: 'Age-Banded', value: 'age_banded' },
  { label: 'Flat Rate per Unit', value: 'flat_rate_per_unit' },
];

const RATE_TYPE_LABELS: Record<string, string> = {
  simple_tiered: 'Simple Tiered',
  age_banded: 'Age-Banded',
  flat_rate_per_unit: 'Flat Rate per Unit',
  manual: 'Manual',
};

interface Product {
  id: number;
  name: string;
}

interface Quote {
  id: number;
  carrierName: string;
  productType: string;
  productId: number | null;
  productLabel: string | null;
  product: Product | null;
  source: 'current' | 'proposal';
  usedDiscovery: boolean;
  warnings: unknown[] | null;
  xlsxPath: string | null;
  originalPdfPath: string | null;
  supplement: { notes: string | null; rates: Record<string, string | number> | null } | null;
  // Untyped here — its real shape depends on productType (SimpleTieredData /
  // AgeBandedData / FlatRateData / ManualQuoteData, see comparisonEngine/types.ts on
  // the backend). Only touched by extractPlanNames() below, which reads just the
  // plan/product name list for the "Plans Shown" picker.
  rawData: unknown;
  // Indices into rawData.plans[]/products[] (position, not plan_name/product_name -
  // see the comment on QuoteRecord.planSelection in comparisonEngine/types.ts for
  // why: two plans in one document can share an identical name).
  planSelection: { included: number[] } | null;
  createdAt: string;
}

// A single carrier document can list a couple dozen plan/product variations in one
// Quote (a real 20-option medical proposal is what prompted this) — this pulls out
// just the name list so the "Plans Shown" picker has something to check boxes
// against. Manual quotes have no plans/products array at all, so they return [],
// which hides the picker entirely (nothing to choose between).
function extractPlanNames(record: Quote): string[] {
  const data = record.rawData as Record<string, unknown> | null;
  if (!data) return [];
  if (record.productType === 'simple_tiered') {
    return ((data.plans as Array<{ plan_name: string }> | undefined) ?? []).map((p) => p.plan_name);
  }
  if (record.productType === 'age_banded' || record.productType === 'flat_rate_per_unit') {
    return ((data.products as Array<{ product_name: string }> | undefined) ?? []).map((p) => p.product_name);
  }
  return [];
}

interface SkippedProduct {
  productLabel: string;
  rateType: string | null;
  reason: string;
  // Carrier is document-level (shared across every product classified out of the
  // same PDF), stamped onto each skipped entry client-side when the batch comes back
  // (see pollExtractStatus's 'done' branch) so "Add rates manually" can pre-fill it.
  carrierName?: string;
}

interface QuoteBucketPanelProps {
  dealId: number;
  source: 'current' | 'proposal';
}

// Parses "Label: Value" lines (or comma-separated "Label: Value" pairs on one line,
// per the field's placeholder text) out of the manual-entry notes box into the
// structured `rates` dict the backend and comparison engine already support end to
// end (ManualQuoteData.rates in comparisonEngine/types.ts) but the form never used to
// populate — without this, every manual entry landed as a single opaque "Notes" row
// instead of aligned rate-tier rows next to the carrier-extracted columns.
//
// Only splits a line on a comma when it's followed by what looks like the start of
// the next "label:" pair, so a thousands-separator comma inside a dollar amount
// ("$1,000") is left alone. Lines with no colon at all are skipped here (they're
// still preserved verbatim in the raw notes text sent alongside this) rather than
// guessed at.
function parseRatesFromText(text: string): Record<string, string | number> | undefined {
  const rates: Record<string, string | number> = {};
  for (const line of text.split('\n')) {
    const segments = line.split(/,(?=\s*[^,:]+:)/);
    for (const segment of segments) {
      const colonIdx = segment.indexOf(':');
      if (colonIdx === -1) continue;
      const label = segment.slice(0, colonIdx).trim();
      const rawValue = segment.slice(colonIdx + 1).trim();
      if (!label || !rawValue) continue;
      const numeric = Number(rawValue.replace(/[$,]/g, ''));
      rates[label] = Number.isFinite(numeric) ? numeric : rawValue;
    }
  }
  return Object.keys(rates).length > 0 ? rates : undefined;
}

export default function QuoteBucketPanel({ dealId, source }: QuoteBucketPanelProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [skippedInfo, setSkippedInfo] = useState<SkippedProduct[] | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  // Set when the manual-entry modal is opened via "Add rates manually" on a skipped
  // item rather than the standalone "Enter manually instead" button - shown as a
  // context banner inside the modal, cleared on close/submit.
  const [manualHint, setManualHint] = useState<string | null>(null);
  const [manualForm] = Form.useForm();
  // Set when a filled-in rate template (see "Download a rate template" below) is
  // attached in the manual-entry modal — submit then goes to POST /upload-template
  // instead of POST /manual, producing a REAL structured quote instead of a
  // "manual" one. Left null for the normal free-text path, which is unchanged.
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  // True while a save is in flight for each modal — drives the OK button's spinner
  // and, more importantly, keeps the modal open until loadQuotes() has actually
  // finished refetching. Closing the modal immediately on a successful response (the
  // old behavior) let an agent reopen it before the fresh data landed, showing the
  // pre-save state and looking exactly like the save "didn't stick" even though it
  // had — this was the real cause behind the plan-selection inconsistency report.
  const [manualSaving, setManualSaving] = useState(false);

  // "Add/edit details" on an existing row - fills gaps on a line that already
  // extracted (or adds context to one that extracted fine) without touching its
  // original rawData. Available on every row, not just ones flagged with Warnings.
  const [supplementTarget, setSupplementTarget] = useState<Quote | null>(null);
  const [supplementForm] = Form.useForm();
  // Same idea as templateFile above, for the "Add/edit details" modal — an attached
  // file there merges into the EXISTING row's supplement instead of creating a new
  // quote (see PATCH /:id/supplement/upload-template).
  const [supplementTemplateFile, setSupplementTemplateFile] = useState<File | null>(null);
  const [supplementSaving, setSupplementSaving] = useState(false);

  // "Plans Shown" — which of a quote's plan/product options actually appear in the
  // comparison, for quotes whose carrier document listed more than one (see
  // extractPlanNames above and PATCH /:id/plan-selection).
  const [planSelectionTarget, setPlanSelectionTarget] = useState<Quote | null>(null);
  const [planSelectionChecked, setPlanSelectionChecked] = useState<number[]>([]);
  const [planSelectionSaving, setPlanSelectionSaving] = useState(false);

  // Per-row reprocess state: quoteId -> latest progress line. A row shows
  // a spinner + this text instead of its editable controls while present.
  const [reprocessingIds, setReprocessingIds] = useState<Record<number, string>>({});

  // Guards against setState after this panel unmounts (e.g. the user
  // switches to a different Deal or Group mid-upload). The upload/reprocess
  // itself keeps running server-side either way - Node polls the Bucket on
  // its own regardless of whether this component is still around to watch -
  // this ref just stops us from updating state on a component that's gone.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadProducts = async () => {
    const res = await fetch('/api/benefit-lines');
    setProducts(await res.json());
  };

  const loadQuotes = async () => {
    setLoading(true);
    try {
      // no-store: this refetch runs right after every save specifically to pick up
      // what was just written (see the comment on manualSaving above) — any cached
      // copy of this same URL, anywhere between here and the database, defeats that
      // and looks exactly like the save didn't stick even when it did.
      const res = await fetch(`/api/deals/${dealId}/quotes?source=${source}`, { cache: 'no-store' });
      setQuotes(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
    loadQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, source]);

  // --- New PDF drop: no pre-selected Product or Rate Type - the Bucket
  // classifies the document and extracts every product it finds. Polls
  // Node's own extract-status endpoint (a read-only check against Node's
  // background job, which creates every Quote independent of whether this
  // panel stays open) for progress text.
  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.pdf',
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      if (uploading) return;

      setUploading(true);
      setProgressText('Uploading...');
      setSkippedInfo(null);

      const pollExtractStatus = async (jobId: string) => {
        if (!isMountedRef.current) return;

        try {
          const res = await fetch(`/api/deals/${dealId}/quotes/upload/extract-status/${jobId}`);
          const json = await res.json();

          if (json.status === 'processing') {
            const lastLog = json.log?.length ? json.log[json.log.length - 1] : null;
            if (isMountedRef.current) {
              setProgressText(lastLog || 'Still processing...');
            }
            setTimeout(() => pollExtractStatus(jobId), POLL_INTERVAL_MS);
            return;
          }

          if (json.status === 'error') {
            if (isMountedRef.current) {
              setUploading(false);
              setProgressText(null);
            }
            message.error(json.error || 'Extraction failed');
            onError?.(new Error(json.error || 'Extraction failed'));
            return;
          }

          // status === 'done'
          const createdCount = json.quotes?.length ?? 0;
          // Stamp the document-level carrier (shared across every product classified
          // out of this one PDF) onto each skipped entry, so "Add rates manually" has
          // something to pre-fill without a separate lookup.
          const skipped: SkippedProduct[] = (json.skipped ?? []).map((s: SkippedProduct) => ({
            ...s,
            carrierName: json.carrier ?? undefined,
          }));

          if (isMountedRef.current) {
            setUploading(false);
            setProgressText(null);
            if (skipped.length > 0) setSkippedInfo(skipped);
            loadQuotes();
          }

          if (createdCount > 0) {
            message.success(
              `${createdCount} product${createdCount === 1 ? '' : 's'} processed` +
                (skipped.length ? `, ${skipped.length} skipped` : '')
            );
          } else {
            message.warning('No products could be extracted from this document');
          }
          onSuccess?.(json);
        } catch (err) {
          if (isMountedRef.current) {
            setUploading(false);
            setProgressText(null);
          }
          message.error('Lost connection while checking extraction status');
          onError?.(err as Error);
        }
      };

      const formData = new FormData();
      formData.append('file', file as File);
      formData.append('source', source);

      try {
        const res = await fetch(`/api/deals/${dealId}/quotes/upload/extract-start`, {
          method: 'POST',
          body: formData,
        });
        const json = await res.json();
        if (!res.ok || !json.jobId) throw new Error(json.error || 'Failed to start extraction');

        setProgressText('Classifying document...');
        pollExtractStatus(json.jobId);
      } catch (err) {
        message.error((err as Error).message);
        onError?.(err as Error);
        setUploading(false);
        setProgressText(null);
      }
    },
  };

  const closeManualModal = () => {
    setManualOpen(false);
    setManualHint(null);
    setTemplateFile(null);
    manualForm.resetFields();
  };

  const submitManual = async (values: { productId: number; carrierName: string; notes?: string }) => {
    if (templateFile) {
      await submitTemplateUpload(values.productId, values.carrierName, values.notes, templateFile);
      return;
    }
    setManualSaving(true);
    try {
      const rates = values.notes ? parseRatesFromText(values.notes) : undefined;
      const res = await fetch(`/api/deals/${dealId}/quotes/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: values.productId,
          source,
          carrierName: values.carrierName,
          notes: values.notes,
          rates,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        message.error(json.error || 'Failed to save');
        return;
      }
      await loadQuotes(); // wait for the fresh row before closing — see manualSaving comment above
      message.success('Saved');
      closeManualModal();
    } finally {
      setManualSaving(false);
    }
  };

  // --- Filled-in rate template upload: alternative to typing rates into the
  // free-text box above. Parsed server-side into a REAL simple_tiered/age_banded/
  // flat_rate_per_unit quote (see lib/rateTemplate.ts) rather than a "manual" one, so
  // it lines up in the comparison exactly like an uploaded carrier PDF would.
  const submitTemplateUpload = async (
    productId: number,
    carrierName: string,
    notes: string | undefined,
    file: File
  ) => {
    setManualSaving(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('productId', String(productId));
      formData.append('source', source);
      formData.append('carrierName', carrierName);
      if (notes) formData.append('notes', notes);

      const res = await fetch(`/api/deals/${dealId}/quotes/upload-template`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.error(json.error || 'Failed to process the rate template');
        return;
      }
      const warningCount = (json.warnings as unknown[] | null)?.length ?? 0;
      await loadQuotes();
      message.success(
        `Saved as ${RATE_TYPE_LABELS[json.productType] ?? json.productType}` +
          (warningCount ? ` — ${warningCount} row(s) skipped, see Warnings` : '')
      );
      closeManualModal();
    } finally {
      setManualSaving(false);
    }
  };

  // --- "Add rates manually" on a skipped product: the classifier found this product
  // in the PDF but couldn't find a rate table for it, so no Quote row exists at all
  // yet - this opens the same manual-entry modal, pre-filled with what's already
  // known (carrier, and the matching catalog Product if the label lines up exactly),
  // so the agent only has to type in the rates themselves.
  const openManualForSkipped = (item: SkippedProduct) => {
    const matchedProduct = products.find((p) => p.name.toLowerCase() === item.productLabel.toLowerCase());
    manualForm.resetFields();
    setTemplateFile(null);
    manualForm.setFieldsValue({
      productId: matchedProduct?.id,
      carrierName: item.carrierName,
    });
    setManualHint(
      `Detected as "${item.productLabel}"${
        item.rateType ? ` (${RATE_TYPE_LABELS[item.rateType] ?? item.rateType})` : ''
      } in the PDF, but no rate table was found — enter what you have below.`
    );
    setManualOpen(true);
  };

  // --- Corrections: Product reassignment (metadata only, no reprocess) ---
  const handleProductChange = async (quoteId: number, productId: number | null) => {
    try {
      const res = await fetch(`/api/deals/${dealId}/quotes/${quoteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, reason: 'Product corrected via UI' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update product');
      message.success('Product updated');
      loadQuotes();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // --- Corrections: Rate Type (requires re-extraction against the
  // original PDF - rawData's shape depends on rate type, so this can't
  // just relabel the row). Polls the single-job status route per quote.
  const pollReprocessStatus = async (quoteId: number, jobId: string) => {
    if (!isMountedRef.current) return;

    try {
      const res = await fetch(`/api/deals/${dealId}/quotes/upload/status/${jobId}`);
      const json = await res.json();

      if (json.status === 'processing') {
        const lastLog = json.log?.length ? json.log[json.log.length - 1] : null;
        if (isMountedRef.current) {
          setReprocessingIds((prev) => ({ ...prev, [quoteId]: lastLog || 'Still processing...' }));
        }
        setTimeout(() => pollReprocessStatus(quoteId, jobId), POLL_INTERVAL_MS);
        return;
      }

      if (json.status === 'error') {
        if (isMountedRef.current) {
          setReprocessingIds((prev) => {
            const next = { ...prev };
            delete next[quoteId];
            return next;
          });
        }
        message.error(json.error || 'Reprocess failed');
        return;
      }

      // status === 'done'
      if (isMountedRef.current) {
        setReprocessingIds((prev) => {
          const next = { ...prev };
          delete next[quoteId];
          return next;
        });
        loadQuotes();
      }
      message.success(`${json.quote?.carrierName ?? 'Line'} reprocessed`);
    } catch {
      if (isMountedRef.current) {
        setReprocessingIds((prev) => {
          const next = { ...prev };
          delete next[quoteId];
          return next;
        });
      }
      message.error('Lost connection while checking reprocess status');
    }
  };

  const startReprocess = async (record: Quote, rateType: string) => {
    setReprocessingIds((prev) => ({ ...prev, [record.id]: 'Starting...' }));
    try {
      const res = await fetch(`/api/deals/${dealId}/quotes/${record.id}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateType, reason: 'Rate Type corrected via UI' }),
      });
      const json = await res.json();
      if (!res.ok || !json.jobId) throw new Error(json.error || 'Failed to start reprocess');
      pollReprocessStatus(record.id, json.jobId);
    } catch (err) {
      setReprocessingIds((prev) => {
        const next = { ...prev };
        delete next[record.id];
        return next;
      });
      message.error((err as Error).message);
    }
  };

  const handleRateTypeChange = (record: Quote, newRateType: string) => {
    if (newRateType === record.productType) return;
    Modal.confirm({
      title: 'Re-run extraction?',
      content: `This re-extracts the original PDF as "${RATE_TYPE_LABELS[newRateType]}" and replaces the current data for this line. The old version is kept in the corrections history, not deleted.`,
      okText: 'Reprocess',
      onOk: () => startReprocess(record, newRateType),
    });
  };

  const handleRetry = (record: Quote) => {
    Modal.confirm({
      title: 'Retry extraction?',
      content: `Re-runs extraction on the original PDF as "${RATE_TYPE_LABELS[record.productType] ?? record.productType}" again.`,
      okText: 'Retry',
      onOk: () => startReprocess(record, record.productType),
    });
  };

  const handleDelete = async (quoteId: number) => {
    try {
      const res = await fetch(`/api/deals/${dealId}/quotes/${quoteId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Removed via UI' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete');
      message.success('Removed');
      loadQuotes();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // --- "Add/edit details" on an existing row: fills in a rate that came through
  // missing, or adds context the extractor wouldn't know to ask for (e.g. an
  // employer contribution note). Merges onto the same row's own column in the
  // comparison rather than creating a new line - the reverse of "Add rates
  // manually" on a skipped product, which has no row to merge into yet.
  const openSupplement = (record: Quote) => {
    supplementForm.setFieldsValue({
      notes: [
        record.supplement?.notes,
        record.supplement?.rates
          ? Object.entries(record.supplement.rates)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    setSupplementTemplateFile(null);
    setSupplementTarget(record);
  };

  const closeSupplementModal = () => {
    setSupplementTarget(null);
    setSupplementTemplateFile(null);
    supplementForm.resetFields();
  };

  const submitSupplement = async (values: { notes?: string }) => {
    if (!supplementTarget) return;
    if (supplementTemplateFile) {
      await submitSupplementTemplateUpload(supplementTarget.id, values.notes, supplementTemplateFile);
      return;
    }
    setSupplementSaving(true);
    try {
      const rates = values.notes ? parseRatesFromText(values.notes) : undefined;
      const res = await fetch(`/api/deals/${dealId}/quotes/${supplementTarget.id}/supplement`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: values.notes ?? null, rates: rates ?? null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save details');
      await loadQuotes();
      message.success('Details saved');
      closeSupplementModal();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSupplementSaving(false);
    }
  };

  // --- Filled-in rate template upload for an EXISTING row: flattened into the same
  // supplement.rates dict the free-text box produces, so it merges into this row's
  // own column instead of creating a new quote (see PATCH /:id/supplement/upload-template).
  const submitSupplementTemplateUpload = async (quoteId: number, notes: string | undefined, file: File) => {
    setSupplementSaving(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (notes) formData.append('notes', notes);

      const res = await fetch(`/api/deals/${dealId}/quotes/${quoteId}/supplement/upload-template`, {
        method: 'PATCH',
        body: formData,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to process the rate template');
      const warningCount = (json.templateWarnings as unknown[] | null)?.length ?? 0;
      await loadQuotes();
      message.success('Details saved' + (warningCount ? ` — ${warningCount} row(s) skipped, see Warnings` : ''));
      closeSupplementModal();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSupplementSaving(false);
    }
  };

  const openPlanSelection = (record: Quote) => {
    const names = extractPlanNames(record);
    // Default: everything checked, as indices — record.planSelection.included is
    // already an index list (position, not name — see the Quote interface comment).
    setPlanSelectionChecked(record.planSelection?.included ?? names.map((_, i) => i));
    setPlanSelectionTarget(record);
  };

  const submitPlanSelection = async () => {
    if (!planSelectionTarget) return;
    const allNames = extractPlanNames(planSelectionTarget);
    // Saving with every box checked is the same as no filter — store null rather
    // than a redundant full list, so a quote that's never been curated and one
    // that's had everything re-checked look identical.
    const included = planSelectionChecked.length === allNames.length ? null : planSelectionChecked;
    setPlanSelectionSaving(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/quotes/${planSelectionTarget.id}/plan-selection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ included, reason: 'Plan selection updated via UI' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save plan selection');
      await loadQuotes(); // wait for the fresh badge/checkbox state before closing
      message.success('Plan selection saved');
      setPlanSelectionTarget(null);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setPlanSelectionSaving(false);
    }
  };

  const columns = [
    {
      title: 'Product',
      key: 'product',
      width: 200,
      render: (_: unknown, record: Quote) =>
        reprocessingIds[record.id] !== undefined ? null : (
          <Select
            allowClear
            placeholder={record.productLabel || 'Unassigned'}
            style={{ width: '100%' }}
            value={record.productId ?? undefined}
            onChange={(value) => handleProductChange(record.id, value ?? null)}
            options={products.map((p) => ({ label: p.name, value: p.id }))}
          />
        ),
    },
    {
      title: 'Carrier',
      dataIndex: 'carrierName',
      key: 'carrierName',
      render: (v: string) =>
        v.length > CARRIER_NAME_MAX ? (
          <Tooltip title={v}>
            <span>{v.slice(0, CARRIER_NAME_MAX)}...</span>
          </Tooltip>
        ) : (
          v
        ),
    },
    {
      title: 'Rate Type',
      key: 'rateType',
      width: 190,
      render: (_: unknown, record: Quote) => {
        if (reprocessingIds[record.id] !== undefined) return null;
        if (record.productType === 'manual' || !record.originalPdfPath) {
          return <Tag>{RATE_TYPE_LABELS[record.productType] ?? record.productType}</Tag>;
        }
        return (
          <Select
            style={{ width: '100%' }}
            value={record.productType}
            options={RATE_TYPE_OPTIONS}
            onChange={(value) => handleRateTypeChange(record, value)}
          />
        );
      },
    },
    {
      title: 'Cost',
      key: 'cost',
      render: (_: unknown, record: Quote) =>
        reprocessingIds[record.id] !== undefined ? (
          <Space>
            <Spin size="small" />
            <span style={{ fontSize: 12, color: '#888' }}>{reprocessingIds[record.id]}</span>
          </Space>
        ) : record.usedDiscovery ? (
          <Tooltip title="New carrier profile learned — used the more expensive discovery pass">
            <span style={{ color: '#d4b106', fontWeight: 700 }}>$</span>
          </Tooltip>
        ) : null,
    },
    {
      title: 'Warnings',
      key: 'warnings',
      render: (_: unknown, record: Quote) =>
        record.warnings && (record.warnings as unknown[]).length > 0 ? (
          <Tag color="orange">{(record.warnings as unknown[]).length} warning(s)</Tag>
        ) : null,
    },
    {
      title: 'Plans Shown',
      key: 'planSelection',
      render: (_: unknown, record: Quote) => {
        if (reprocessingIds[record.id] !== undefined) return null;
        const names = extractPlanNames(record);
        if (names.length <= 1) return null;
        const includedCount = record.planSelection?.included?.length ?? names.length;
        return (
          <Button size="small" onClick={() => openPlanSelection(record)}>
            {includedCount === names.length ? `All ${names.length} shown` : `${includedCount} of ${names.length} shown`}
          </Button>
        );
      },
    },
    {
      title: 'Added',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '',
      key: 'original',
      render: (_: unknown, record: Quote) =>
        record.originalPdfPath ? (
          <Tooltip title="View original PDF">
            <a href={`/api/deals/${dealId}/quotes/${record.id}/original`} target="_blank" rel="noreferrer">
              <EyeOutlined />
            </a>
          </Tooltip>
        ) : null,
    },
    {
      title: '',
      key: 'download',
      render: (_: unknown, record: Quote) =>
        record.xlsxPath ? (
          <Tooltip title="Download extraction workbook">
            <a href={`/api/deals/${dealId}/quotes/${record.id}/download`}>
              <DownloadOutlined />
            </a>
          </Tooltip>
        ) : null,
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, record: Quote) => {
        if (reprocessingIds[record.id] !== undefined) return null;
        return (
          <Space>
            <Button
              size="small"
              icon={<FormOutlined />}
              title="Add/edit details"
              onClick={() => openSupplement(record)}
            />
            {record.originalPdfPath && (
              <Button
                size="small"
                icon={<RedoOutlined />}
                title="Retry extraction"
                onClick={() => handleRetry(record)}
              />
            )}
            <Popconfirm
              title="Remove this line?"
              description="It's excluded from the comparison but kept for the corrections history - not permanently deleted."
              okText="Remove"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(record.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} title="Remove" />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <Button
          onClick={() => {
            manualForm.resetFields();
            setManualHint(null);
            setTemplateFile(null);
            setManualOpen(true);
          }}
          disabled={uploading}
        >
          Enter manually instead
        </Button>
      </div>

      <Dragger {...uploadProps} disabled={uploading}>
        <p className="ant-upload-drag-icon">{uploading ? <LoadingOutlined spin /> : <InboxOutlined />}</p>
        <p className="ant-upload-text">
          {uploading
            ? progressText || 'Processing - this can take a few minutes for an unfamiliar carrier layout...'
            : `Drop ${source === 'current' ? "the group's current plan" : 'a carrier proposal'} PDF here`}
        </p>
        <p className="ant-upload-hint" style={{ fontSize: 12 }}>
          Every product in the document is detected and extracted automatically - no need to pick a
          benefit type or rate structure up front. Review and correct the results below.
        </p>
      </Dragger>

      {skippedInfo && skippedInfo.length > 0 && (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          closable
          onClose={() => setSkippedInfo(null)}
          message={`${skippedInfo.length} product(s) in the last upload couldn't be extracted`}
          description={
            <List
              size="small"
              dataSource={skippedInfo}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button key="fill" type="link" size="small" onClick={() => openManualForSkipped(item)}>
                      Add rates manually
                    </Button>,
                  ]}
                >
                  <strong>{item.productLabel}</strong>
                  {item.rateType ? ` (${item.rateType})` : ''} — {item.reason}
                </List.Item>
              )}
            />
          }
        />
      )}

      <Table
        style={{ marginTop: 16 }}
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={quotes}
        pagination={false}
        size="small"
      />

      <Modal
        title="Enter plan info manually"
        open={manualOpen}
        onCancel={closeManualModal}
        onOk={() => manualForm.submit()}
        confirmLoading={manualSaving}
        cancelButtonProps={{ disabled: manualSaving }}
        closable={!manualSaving}
        maskClosable={!manualSaving}
      >
        {manualHint && (
          <Alert style={{ marginBottom: 16 }} type="info" showIcon message={manualHint} />
        )}
        <Form form={manualForm} layout="vertical" onFinish={submitManual}>
          <Form.Item name="productId" label="Product" rules={[{ required: true }]}>
            <Select options={products.map((p) => ({ label: p.name, value: p.id }))} />
          </Form.Item>
          <Form.Item name="carrierName" label="Carrier" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="notes"
            label={templateFile ? 'Notes (optional)' : 'Rates / notes (whatever\'s available)'}
            extra={
              templateFile
                ? "Kept alongside the template's rates as a note — doesn't need to include the rates themselves."
                : 'Lines like "EE: $412" or "EE: $412, EE+Spouse: $824" become aligned rows in the comparison workbook. Anything else you type is kept as a note alongside them.'
            }
          >
            <Input.TextArea rows={4} placeholder={'EE: $412\nEE+Spouse: $824\nEE+Child(ren): $610\nFamily: $1,050'} />
          </Form.Item>

          <Divider style={{ margin: '4px 0 16px' }}>OR</Divider>

          <Form.Item label="Upload a filled-in rate template">
            <div style={{ marginBottom: 8 }}>
              <a href={`/api/deals/${dealId}/quotes/rate-template`} download>
                Download a blank rate template
              </a>
              <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                For a more complex rate structure (e.g. age-banded). Fill in whichever ONE tab matches this
                product and leave the other two blank — the rates line up in the comparison exactly like an
                uploaded carrier PDF, instead of becoming a plain note.
              </div>
            </div>
            <Upload
              accept=".xlsx"
              maxCount={1}
              fileList={templateFile ? [{ uid: '-1', name: templateFile.name, status: 'done' }] : []}
              beforeUpload={(file) => {
                setTemplateFile(file);
                return false; // hand off to submitManual instead of antd's own auto-upload
              }}
              onRemove={() => setTemplateFile(null)}
            >
              <Button icon={<UploadOutlined />}>Attach filled-in template</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={supplementTarget ? `Add/edit details — ${supplementTarget.carrierName}` : 'Add/edit details'}
        open={!!supplementTarget}
        onCancel={closeSupplementModal}
        onOk={() => supplementForm.submit()}
        confirmLoading={supplementSaving}
        cancelButtonProps={{ disabled: supplementSaving }}
        closable={!supplementSaving}
        maskClosable={!supplementSaving}
      >
        <p style={{ color: '#888', fontSize: 13, marginTop: -8 }}>
          This fills gaps on this row without touching what was already extracted — useful when a rate
          came through missing, or to add context the extractor wouldn't know to ask for.
        </p>
        <Form form={supplementForm} layout="vertical" onFinish={submitSupplement}>
          <Form.Item
            name="notes"
            label={supplementTemplateFile ? 'Notes (optional)' : 'Rates / notes'}
            extra={
              supplementTemplateFile
                ? "Kept alongside the template's rates as a note — doesn't need to include the rates themselves."
                : 'Lines like "EE: $412" or "EE: $412, EE+Spouse: $824" become aligned rows in the comparison ' +
                  "workbook, right alongside this carrier's extracted data. Anything else you type is kept as a note."
            }
          >
            <Input.TextArea rows={4} placeholder={'EE: $412\nEE+Spouse: $824\nEE+Child(ren): $610\nFamily: $1,050'} />
          </Form.Item>

          <Divider style={{ margin: '4px 0 16px' }}>OR</Divider>

          <Form.Item label="Upload a filled-in rate template">
            <div style={{ marginBottom: 8 }}>
              <a href={`/api/deals/${dealId}/quotes/rate-template`} download>
                Download a blank rate template
              </a>
              <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                For a more complex rate structure (e.g. age-banded). Fill in whichever ONE tab matches this
                product and leave the other two blank — the values merge into this row exactly like carrier
                data would, instead of becoming a plain note.
              </div>
            </div>
            <Upload
              accept=".xlsx"
              maxCount={1}
              fileList={supplementTemplateFile ? [{ uid: '-1', name: supplementTemplateFile.name, status: 'done' }] : []}
              beforeUpload={(file) => {
                setSupplementTemplateFile(file);
                return false; // hand off to submitSupplement instead of antd's own auto-upload
              }}
              onRemove={() => setSupplementTemplateFile(null)}
            >
              <Button icon={<UploadOutlined />}>Attach filled-in template</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={planSelectionTarget ? `Choose plans to show — ${planSelectionTarget.carrierName}` : 'Choose plans to show'}
        open={!!planSelectionTarget}
        onCancel={() => setPlanSelectionTarget(null)}
        onOk={submitPlanSelection}
        okButtonProps={{ disabled: planSelectionChecked.length === 0 }}
        confirmLoading={planSelectionSaving}
        cancelButtonProps={{ disabled: planSelectionSaving }}
        closable={!planSelectionSaving}
        maskClosable={!planSelectionSaving}
      >
        <p style={{ color: '#888', fontSize: 13, marginTop: -8 }}>
          Uncheck any plan options that shouldn&apos;t appear in the comparison — nothing is deleted, and
          this can be changed anytime.
        </p>
        {planSelectionTarget && (
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            value={planSelectionChecked}
            onChange={(vals) => setPlanSelectionChecked(vals as number[])}
            // value is the plan's INDEX, not its name — two plans can share an
            // identical name (auto-generated combinatorial names like "ANG TRAD
            // 5000 7000" collide easily), and antd's Checkbox.Group treats options
            // with the same value as the same checkbox, which used to make
            // checking/unchecking one silently affect its same-named twin too.
            options={extractPlanNames(planSelectionTarget).map((name, idx) => ({ label: name, value: idx }))}
          />
        )}
      </Modal>
    </div>
  );
}
