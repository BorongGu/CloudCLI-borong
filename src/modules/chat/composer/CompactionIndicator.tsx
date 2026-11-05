import type { ReactNode } from 'react';
import { Shrink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** ActivityIndicator gives context compression its own notice, separate from the normal working verbs. */
export function CompactionIndicator({ elapsedLabel, canInterrupt, onAbort, hint }: {
  elapsedLabel?: string;
  canInterrupt: boolean;
  onAbort?: () => void;
  hint?: ReactNode;
}) {
  const { t } = useTranslation('chat');
  return <div data-compaction-indicator className="space-y-1">
    <div className="rounded-lg border border-primary/15 bg-primary/[0.035] px-2.5 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <Shrink className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <span role="status" className="font-medium text-foreground">{t('compaction.running', { defaultValue: 'Compacting context' })}</span>
        {elapsedLabel && <span className="tabular-nums text-muted-foreground">{elapsedLabel}</span>}
        {canInterrupt && onAbort && <button type="button" onClick={onAbort}
          className="ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}>
          <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span><kbd className="hidden text-[10px] sm:inline">esc</kbd>
        </button>}
      </div>
      <p className="mt-1 pl-5 text-muted-foreground">{t('input.compactionHint', { defaultValue: 'You can open a new conversation to avoid waiting.' })}</p>
    </div>
    {hint && <div className="hidden justify-center lg:flex">{hint}</div>}
  </div>;
}
