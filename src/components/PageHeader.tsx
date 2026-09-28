import { ReactNode } from 'react';
import { ArrowLeft, LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: ReactNode;
}

/** Title row shared by every sub-page; the global navigation lives in the app header. */
export default function PageHeader({ icon: Icon, title, subtitle, onBack, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <button
          onClick={onBack}
          className="pressable group -ml-1 mb-3 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-gray-500 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
          Back to Dashboard
        </button>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-400/25 bg-gradient-to-br from-brand-500/20 to-brand-400/5">
            <Icon className="h-5 w-5 text-brand-300" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
