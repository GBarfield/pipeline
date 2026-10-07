// Destination: apps/web/src/components/EmployeeNavigatorPanel.tsx
import { useEffect, useState } from 'react';
import { Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';

interface Election {
  id: number;
  carrier: string | null;
  plan: string | null;
  benefit: string | null;
  coverageLevel: string | null;
  totalMonthlyPlanCost: string | null;
  startDate: string | null;
  endDate: string | null;
  declineReason: string | null;
  endReason: string | null;
}

interface Employee {
  id: number;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  fullName: string | null;
  elections: Election[];
}

// One flattened table row per election, or a placeholder row for an
// employee with zero elections on file.
interface EnRow {
  key: string;
  employeeId: number;
  employeeName: string;
  election: Election | null;
}

interface EmployeeNavigatorPanelProps {
  groupId: number | null;
}

function employeeDisplayName(e: Employee): string {
  if (e.displayName) return e.displayName;
  if (e.fullName) return e.fullName;
  if (e.firstName || e.lastName) return [e.firstName, e.lastName].filter(Boolean).join(' ');
  return '(no name on file)';
}

function formatDate(v: string | null): string {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString();
}

function formatCurrency(v: string | null): string {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  return Number.isNaN(n) ? '-' : `$${n.toFixed(2)}`;
}

function electionStatus(e: Election): { label: string; color?: string } {
  if (e.declineReason) return { label: 'Declined', color: 'default' };
  if (e.endDate) return { label: 'Terminated', color: 'red' };
  return { label: 'Active', color: 'green' };
}

function flattenRows(employees: Employee[]): EnRow[] {
  const rows: EnRow[] = [];
  for (const emp of employees) {
    const name = employeeDisplayName(emp);
    if (emp.elections.length === 0) {
      rows.push({ key: `emp-${emp.id}`, employeeId: emp.id, employeeName: name, election: null });
    } else {
      for (const election of emp.elections) {
        rows.push({ key: `election-${election.id}`, employeeId: emp.id, employeeName: name, election });
      }
    }
  }
  return rows;
}

export default function EmployeeNavigatorPanel({ groupId }: EmployeeNavigatorPanelProps) {
  const [rows, setRows] = useState<EnRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!groupId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/groups/${groupId}/employee-navigator`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((employees: Employee[]) => {
        if (!cancelled) setRows(flattenRows(employees));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const columns: TableColumnsType<EnRow> = [
    { title: 'Employee', dataIndex: 'employeeName', key: 'employeeName' },
    {
      title: 'Carrier',
      key: 'carrier',
      render: (_, row) => row.election?.carrier ?? '-',
    },
    {
      title: 'Plan / Benefit',
      key: 'plan',
      render: (_, row) => {
        if (!row.election) return '-';
        const { plan, benefit } = row.election;
        if (plan && benefit) return `${plan} (${benefit})`;
        return plan ?? benefit ?? '-';
      },
    },
    {
      title: 'Coverage Tier',
      key: 'coverageLevel',
      render: (_, row) => row.election?.coverageLevel ?? '-',
    },
    {
      title: 'Monthly Cost',
      key: 'totalMonthlyPlanCost',
      render: (_, row) => formatCurrency(row.election?.totalMonthlyPlanCost ?? null),
    },
    {
      title: 'Effective',
      key: 'startDate',
      render: (_, row) => formatDate(row.election?.startDate ?? null),
    },
    {
      title: 'End',
      key: 'endDate',
      render: (_, row) => formatDate(row.election?.endDate ?? null),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, row) => {
        if (!row.election) return <Tag>No elections on file</Tag>;
        const { label, color } = electionStatus(row.election);
        return <Tag color={color}>{label}</Tag>;
      },
    },
  ];

  return (
    <Table
      rowKey="key"
      loading={loading}
      size="small"
      pagination={{ pageSize: 20 }}
      columns={columns}
      dataSource={rows}
    />
  );
}
