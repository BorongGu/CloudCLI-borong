import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { CodexGoal } from '@/shared/types';

/** ChatInterface uses this persistent native-goal status row above the composer. */
export function CodexGoalPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('chat');
  const { subscribe, sendMessage } = useWebSocket();
  // Tag async results with their session so navigation never displays another goal.
  const [snapshot, setSnapshot] = useState<{ sessionId: string; goal: CodexGoal | null } | null>(null);
  // Keep goal controls single-flight and show native API failures beside them.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  // Keep the last native API failure visible until a successful refresh or action.
  const [error, setError] = useState('');
  const control = useRef<(action: 'pause' | 'resume' | 'clear') => Promise<void>>(async () => {});
  const goal = snapshot?.sessionId === sessionId ? snapshot.goal : null;
  const pending = sessionId !== null && pendingSessionId === sessionId;

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
  return <div data-testid="codex-goal-panel" className="mx-3 mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs sm:mx-4">
    {goal && <>
      <div className="flex flex-wrap items-center gap-2">
        <strong>Goal · {t(`goal.status.${goal.status}`, { defaultValue: goal.status })}</strong>
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">{goal.tokensUsed.toLocaleString()}{goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tokens · {Math.floor(goal.timeUsedSeconds / 60)}m</span>
        <div className="ml-auto flex gap-3">
          {goal.status !== 'complete' && <button type="button" disabled={pending} onClick={() => void control.current(goal.status === 'active' ? 'pause' : 'resume')}>
            {t(goal.status === 'active' ? 'goal.pause' : 'goal.resume', { defaultValue: goal.status === 'active' ? '暂停' : '恢复' })}
          </button>}
          <button type="button" disabled={pending} onClick={() => void control.current('clear')}>{t('goal.clear', { defaultValue: '清除' })}</button>
        </div>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{goal.objective}</p>
    </>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}
