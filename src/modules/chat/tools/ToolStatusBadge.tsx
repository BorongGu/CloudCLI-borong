import { cn } from '@/shared/utils';
import type { ToolStatus } from '@/shared/types';


const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-primary/10 text-primary',
  },
  completed: {
    label: 'Completed',
    className: 'bg-muted text-muted-foreground',
  },
  error: {
    label: 'Error',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  denied: {
    label: 'Denied',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  },
};

type ToolStatusBadgeProps = {
  status: ToolStatus;
  className?: string;
};

/**
 * Used by chat's ToolRenderer, BashCommandDisplay and OneLineDisplay to label a
 * tool call's pending, running, error or denied state.
 */
export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
