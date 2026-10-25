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
  const [pending, setPending] = useState(false);
  // Keep the last native API failure visible until a successful refresh or action.
  const [error, setError] = useState('');
  const reload = useRef<() => Promise<void>>(async () => {});
  const goal = snapshot?.sessionId === sessionId ? snapshot.goal : null;

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let attached = false;
    const accept = (value: CodexGoal | null) => {
      if (disposed) return;
      setSnapshot({ sessionId, goal: value }); setError('');
      if (value?.status === 'active' && !attached) {
        attached = sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, watchGoal: true }] }) !== false;
      }
      if (value?.status !== 'active') attached = false;
    };
    const read = async () => {
      try {
        const response = await api.providers.sessionGoal(sessionId, { signal: AbortSignal.timeout(8000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Goal status failed.');
        accept(result.data.goal);
      } catch (cause) { if (!disposed) setError(String(cause instanceof Error ? cause.message : cause)); }
    };
    reload.current = read;
    const poll = async () => { await read(); if (!disposed) timer = setTimeout(poll, 2500); };
    void poll();
    const unsubscribe = subscribe(event => {
      if (event.kind === 'websocket_reconnected') { attached = false; void read(); }
      if (event.kind === 'status' && event.text === 'codex_goal' && event.sessionId === sessionId) {
        accept(event.goal as CodexGoal | null);
      }
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [sessionId, sendMessage, subscribe]);

  const control = async (action: 'pause' | 'resume' | 'clear') => {
    if (!sessionId || pending) return;
    setPending(true); setError('');
    try {
      const response = await api.providers.setSessionGoal(sessionId, action);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Goal operation failed.');
      await reload.current();
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setPending(false); }
  };
  if (!goal && !error) return null;
  return <div data-testid="codex-goal-panel" className="mx-3 mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs sm:mx-4">
    {goal && <>
      <div className="flex flex-wrap items-center gap-2">
        <strong>Goal · {t(`goal.status.${goal.status}`, { defaultValue: goal.status })}</strong>
        <span className="text-muted-foreground">{goal.tokensUsed.toLocaleString()}{goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tokens · {Math.floor(goal.timeUsedSeconds / 60)}m</span>
        <div className="ml-auto flex gap-3">
          {goal.status !== 'complete' && <button type="button" disabled={pending} onClick={() => void control(goal.status === 'active' ? 'pause' : 'resume')}>
            {t(goal.status === 'active' ? 'goal.pause' : 'goal.resume', { defaultValue: goal.status === 'active' ? '暂停' : '恢复' })}
          </button>}
          <button type="button" disabled={pending} onClick={() => void control('clear')}>{t('goal.clear', { defaultValue: '清除' })}</button>
        </div>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{goal.objective}</p>
    </>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}
