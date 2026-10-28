import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Flag, Pause, Play, X } from 'lucide-react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { CodexGoal } from '@/shared/types';

const compactTokenFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** ChatInterface supplies this native-goal row to ChatComposer's input header. */
export function CodexGoalPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('chat');
  const { subscribe, sendMessage } = useWebSocket();
  // Tag async results with their session so navigation never displays another goal.
  const [snapshot, setSnapshot] = useState<{ sessionId: string; goal: CodexGoal | null } | null>(null);
  // Keep goal controls single-flight and show native API failures beside them.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  // Keep the last native API failure visible until a successful refresh or action.
  const [error, setError] = useState('');
  // Retain the user's choice to read the full objective for this session.
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const control = useRef<(action: 'pause' | 'resume' | 'clear') => Promise<void>>(async () => {});
  const goal = snapshot?.sessionId === sessionId ? snapshot.goal : null;
  const pending = sessionId !== null && pendingSessionId === sessionId;
  const expanded = sessionId !== null && expandedSessionId === sessionId;
  const detailsId = useId();

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let attached = false;
    let revision = 0;
    let controlling = false;
    const accept = (value: CodexGoal | null) => {
      if (disposed) return;
      setSnapshot(previous => {
        const before = previous?.goal;
        return previous?.sessionId === sessionId && before?.objective === value?.objective
          && before?.status === value?.status && before?.tokensUsed === value?.tokensUsed
          && before?.tokenBudget === value?.tokenBudget && before?.timeUsedSeconds === value?.timeUsedSeconds
          ? previous : { sessionId, goal: value };
      });
      setError('');
      if (value?.status === 'active' && !attached) {
        // Goal observation only needs live events; replaying from zero also
        // rewinds the transcript and can retrigger observation on old statuses.
        attached = sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, watchGoal: true, replay: false }] }) !== false;
      }
      if (value?.status !== 'active') attached = false;
    };
    const read = async () => {
      if (controlling || disposed) return;
      const requestedRevision = ++revision;
      try {
        const response = await api.providers.sessionGoal(sessionId, { signal: AbortSignal.timeout(8000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Goal status failed.');
        if (requestedRevision === revision) accept(result.data.goal);
      } catch (cause) {
        if (!disposed && requestedRevision === revision) setError(String(cause instanceof Error ? cause.message : cause));
      }
    };
    control.current = async action => {
      if (controlling || disposed) return;
      controlling = true;
      ++revision; // Invalidate reads started before this operation.
      setPendingSessionId(sessionId); setError('');
      try {
        const response = await api.providers.setSessionGoal(sessionId, action);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Goal operation failed.');
        accept(result.data.goal);
      } catch (cause) {
        if (!disposed) setError(String(cause instanceof Error ? cause.message : cause));
      } finally {
        controlling = false;
        if (!disposed) setPendingSessionId(null);
      }
    };
    const poll = async () => { await read(); if (!disposed) timer = setTimeout(poll, 2500); };
    void poll();
    const unsubscribe = subscribe(event => {
      if (event.kind === 'websocket_reconnected') { attached = false; void read(); }
      if (event.kind === 'status' && event.text === 'codex_goal' && event.sessionId === sessionId) {
        ++revision;
        if (!controlling) accept(event.goal as CodexGoal | null);
      }
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [sessionId, sendMessage, subscribe]);

  if (!goal && !error) return null;
  const usageLabel = goal
    ? `${goal.tokensUsed.toLocaleString()}${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tokens · ${Math.floor(goal.timeUsedSeconds / 60)}m`
    : '';
  const actionLabel = t(goal?.status === 'active' ? 'goal.pause' : 'goal.resume');

  return (
    <div data-testid="codex-goal-panel" className="chat-goal-panel mx-3 mt-1 border-b border-border/50 pb-1 text-[11px] sm:mx-4 sm:mt-1.5">
      {goal && <>
        <div className="flex h-7 min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label={goal.objective}
            aria-expanded={expanded}
            aria-controls={detailsId}
            title={goal.objective}
            onClick={() => setExpandedSessionId(expanded ? null : sessionId)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Flag aria-hidden className="h-3 w-3 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">Goal</span>
            <span className="truncate text-muted-foreground">{t(`goal.status.${goal.status}`, { defaultValue: goal.status })}</span>
            <span className="hidden min-w-0 flex-1 truncate text-muted-foreground/70 sm:block">{goal.objective}</span>
            <ChevronDown aria-hidden className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <span title={usageLabel} aria-label={usageLabel} className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
            {compactTokenFormatter.format(goal.tokensUsed)}<span className="hidden sm:inline"> tokens</span> · {Math.floor(goal.timeUsedSeconds / 60)}m
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {goal.status !== 'complete' && (
              <button type="button" aria-label={actionLabel} title={actionLabel} disabled={pending}
                onClick={() => void control.current(goal.status === 'active' ? 'pause' : 'resume')}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                {goal.status === 'active' ? <Pause aria-hidden className="h-3 w-3" /> : <Play aria-hidden className="h-3 w-3" />}
              </button>
            )}
            <button type="button" aria-label={t('goal.clear')} title={t('goal.clear')} disabled={pending}
              onClick={() => void control.current('clear')}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
              <X aria-hidden className="h-3 w-3" />
            </button>
          </div>
        </div>
        {expanded && (
          <div id={detailsId} className="max-h-36 overflow-y-auto pb-2 pt-1 text-xs leading-relaxed text-muted-foreground">
            <p className="whitespace-pre-wrap break-words">{goal.objective}</p>
            <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">{usageLabel}</p>
          </div>
        )}
      </>}
      {error && <p role="alert" className="pb-1 text-muted-foreground">{error}</p>}
    </div>
  );
}
