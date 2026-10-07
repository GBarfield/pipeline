import { Select } from 'antd';
import { useAuth } from '../context/AuthContext';
import { useDivision } from '../context/DivisionContext';

export function DivisionSwitcher() {
  const { user } = useAuth();
  const { currentDivision, divisions, setDivision, loading } = useDivision();

  if (loading || !currentDivision) return null;

  if (user?.role !== 'SUPER_USER') {
    return (
      <span style={{ fontWeight: 'bold' }}>
        {currentDivision.name.toUpperCase()}
      </span>
    );
  }

  return (
    <Select
      value={currentDivision.id}
      onChange={(divisionId) => setDivision(divisionId)}
      options={divisions.map((d) => ({ value: d.id, label: d.name.toUpperCase() }))}
      variant="borderless"
      style={{ fontWeight: 'bold', minWidth: 220 }}
      popupMatchSelectWidth={false}
    />
  );
}