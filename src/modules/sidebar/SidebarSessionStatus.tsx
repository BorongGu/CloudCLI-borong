import { useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { cn, isSessionCompleted, subscribeToSessionCompletion } from '@/shared/utils';

type SidebarSessionStatusProps = {
  sessionId: string;
  isProcessing: boolean;
  hasBackgroundWork: boolean;
  needsAttention: boolean;
  isSelected: boolean;
  t: TFunction;
};

/** Project and Recent Conversation rows share running, action-needed and final-reply markers. */
export function SidebarSessionStatus({ sessionId, isProcessing, hasBackgroundWork, needsAttention, isSelected, t }: SidebarSessionStatusProps) {
  const completed = useSyncExternalStore(subscribeToSessionCompletion, () => isSessionCompleted(sessionId), () => false);
  const attention = needsAttention && !isSelected;
  const running = isProcessing || hasBackgroundWork;
  if (!attention && !running && !completed) return null;
  const state = attention ? 'attention' : running ? 'running' : 'completed';
  const label = attention
    ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
    : running
      ? isProcessing ? t('tooltips.processingSessionIndicator', 'Processing session') : t('tooltips.backgroundWorkIndicator', 'Background work running')
      : t('tooltips.completedSessionIndicator', 'Completed with a final reply');
  return <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
    <Tooltip content={label} position="right">
      <span role="status" aria-label={label} data-session-status={state} className={cn(
        state === 'completed' ? 'flex h-3 w-3 items-center justify-center text-primary/70' : 'block h-1.5 w-1.5 rounded-full',
        state === 'attention' && 'ring-1 ring-primary/60',
        state === 'running' && 'bg-primary/80',
      )}>{state === 'completed' && <Check aria-hidden className="h-3 w-3" />}</span>
    </Tooltip>
  </div>;
}
