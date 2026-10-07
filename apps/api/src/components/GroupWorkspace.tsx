// Destination: apps/web/src/components/GroupWorkspace.tsx
import { Collapse, Descriptions, Button } from 'antd';
import QuoteBucketPanel from './QuoteBucketPanel';

interface GroupWorkspaceProps {
  groupId: number;
  groupName: string;
  group: Record<string, any>;
}

export default function GroupWorkspace({ groupId, group }: GroupWorkspaceProps) {
  return (
    <Collapse
      defaultActiveKey={['current', 'proposal']}
      items={[
        {
          key: 'find',
          label: '1. Find the Group',
          children: <p>Handled above via the existing Groups search/select — nothing new here yet.</p>,
        },
        {
          key: 'demographics',
          label: '2. Group Demographics',
          children: (
            <Descriptions column={2} size="small">
              <Descriptions.Item label="Company">{group.company}</Descriptions.Item>
              <Descriptions.Item label="Industry">{group.industry || '—'}</Descriptions.Item>
              <Descriptions.Item label="SIC Code">{group.sicCode || '—'}</Descriptions.Item>
              <Descriptions.Item label="Effective Date">
                {group.effectiveDate ? new Date(group.effectiveDate).toLocaleDateString() : '—'}
              </Descriptions.Item>
            </Descriptions>
          ),
        },
        {
          key: 'current',
          label: '3. Current Products',
          children: <QuoteBucketPanel groupId={groupId} source="current" />,
        },
        {
          key: 'proposal',
          label: '4. Proposal Worksheets',
          children: (
            <>
              <QuoteBucketPanel groupId={groupId} source="proposal" />
              <Button style={{ marginTop: 16 }} type="primary" disabled>
                Build Comparison (coming soon)
              </Button>
            </>
          ),
        },
        {
          key: 'final',
          label: '5. Final Proposal',
          children: <Button disabled>Generate Final Proposal (coming soon)</Button>,
        },
      ]}
    />
  );
}