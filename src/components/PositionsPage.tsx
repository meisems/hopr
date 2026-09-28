import { Coins } from 'lucide-react';
import PositionsTable from './PositionsTable';
import PageHeader from './PageHeader';

interface PositionsPageProps {
  onBack: () => void;
}

export default function PositionsPage({ onBack }: PositionsPageProps) {
  return (
    <div className="text-white">
      {/* Header */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <PageHeader icon={Coins} title="Positions" subtitle="Open positions and live PnL" onBack={onBack} />
        <PositionsTable />
      </main>
    </div>
  );
}
