import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import type { BackgroundTaskSummary, SessionActivity } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { CompactionIndicator } from '@/modules/chat/composer/CompactionIndicator';
import '@/modules/chat/composer/activity.css';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  hint?: ReactNode;
};

// Claude Code-style verbs rotate in a fixed-width slot; real provider details remain visible.
const ACTION_WORDS = ['Pondering', 'Crafting', 'Brewing', 'Mulling', 'Tinkering', 'Cogitating', 'Deliberating', 'Conjuring'];
const GENERIC_STATUS = /^(thinking|processing|analyzing|working|computing|reasoning)$/i;
const EXIT_ANIMATION_MS = 220;

/** What the background work is: the one task by kind and name, or how many when there are several. */
function describeBackgroundTasks(allTasks: BackgroundTaskSummary[], t: TFunction): string {
  const tasks = ownBackgroundTasks(allTasks);
  return tasks.length === 1
    ? describeBackgroundTask(tasks[0], t)
    : t('claudeStatus.backgroundTask.count', { count: tasks.length, defaultValue: '{{count}} tasks' });
}

/** ChatComposer uses this bottom row for activity, elapsed time, shortcuts and Stop. */
export default function ActivityIndicator({ activity, onAbort, hint }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  // Retain the last run just long enough to complete the existing exit transition.
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  // This flag distinguishes the outgoing row from the next live run.
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  // A single one-second clock drives elapsed time and the slow verb rotation.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return hint ? <div className="flex justify-center">{hint}</div> : null;

  const isBackground = Boolean(renderedActivity.background);
  const status = (renderedActivity.statusText || '').replace(/[.\u2026]+$/, '').trim();
  const compacting = !isBackground && (renderedActivity.compactingSince !== undefined || status === 'Compacting');
  const wordIndex = (Math.floor(renderedActivity.startedAt / 1000) + Math.floor(elapsedSeconds / 12)) % ACTION_WORDS.length;
  const label = isBackground
    ? t('claudeStatus.backgroundWork', 'Background work')
    : status && !GENERIC_STATUS.test(status) ? status : ACTION_WORDS[wordIndex];
  const detail = isBackground ? describeBackgroundTasks(renderedActivity.tasks ?? [], t) : '';

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  if (compacting) {
    const since = renderedActivity.compactingSince;
    const compactSeconds = since === undefined ? null : Math.max(0, elapsedSeconds - Math.floor((since - renderedActivity.startedAt) / 1000));
    const compactElapsed = compactSeconds === null ? undefined : compactSeconds < 60
      ? t('claudeStatus.elapsed.seconds', { count: compactSeconds, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', { minutes: Math.floor(compactSeconds / 60), seconds: compactSeconds % 60, defaultValue: '{{minutes}}m {{seconds}}s' });
    return <CompactionIndicator elapsedLabel={compactElapsed} canInterrupt={renderedActivity.canInterrupt} onAbort={onAbort} hint={hint} />;
  }
  return (
    <div
      data-activity-indicator
      className={`chat-activity-row grid min-h-6 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-1 text-[11px] text-muted-foreground ${hint ? 'lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : ''} ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <svg viewBox="0 0 20 20" className="chat-activity-spinner h-3.5 w-3.5 shrink-0 text-primary" data-activity-spinner aria-hidden>
          <path d="M10 1v18M1 10h18M3.6 3.6l12.8 12.8M3.6 16.4L16.4 3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span role="status" title={label} className="inline-block w-[15ch] shrink-0 truncate font-mono font-medium text-primary">{`${label}…`}</span>
        {detail && (
          <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
      </div>

      {hint}
      <div className="justify-self-end">
        {renderedActivity.canInterrupt && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="inline-flex h-6 items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
            <kbd className="hidden rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
              esc
            </kbd>
          </button>
        )}
      </div>
    </div>
  );
}
