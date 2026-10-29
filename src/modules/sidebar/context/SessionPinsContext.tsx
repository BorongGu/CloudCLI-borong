import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/shared/api';
import type { Project, RecentConversationListItem } from '@/shared/types';

type SessionPins = {
  conversations: RecentConversationListItem[];
  pinnedIds: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
  error: 'load' | 'save' | null;
  setPinned(sessionId: string, pinned: boolean): void;
  refresh(): Promise<void>;
};
const SessionPinsContext = createContext<SessionPins | null>(null);

/** Sidebar owns account pins shared by its top section, project rows and conversation menus. */
export function SessionPinsProvider({ children, projects }: { children: ReactNode; projects?: Project[] }) {
  // Server-resolved rows keep old pinned sessions available beyond loaded history pages.
  const [conversations, setConversations] = useState<RecentConversationListItem[]>([]);
  // Disable a session's action until its individual server write settles.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Surface a failed read/write in the sidebar while preserving the last confirmed pins.
  const [error, setError] = useState<SessionPins['error']>(null);
  // Serialize edits and invalidate older reads so a slow poll cannot undo a pin.
  const pending = useRef(new Set<string>());
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const loading = useRef(false);
  const mounted = useRef(true);
  const accept = useCallback((rows: RecentConversationListItem[]) => {
    setConversations(current => JSON.stringify(current) === JSON.stringify(rows) ? current : rows);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    if (loading.current || pending.current.size || document.visibilityState === 'hidden') return;
    loading.current = true;const started = revision.current;
    try {
      const response = await api.user.sessionPins();const data = await response.json();
      if (!response.ok || !Array.isArray(data.sessions)) throw new Error('Pin read failed');
      if (mounted.current && started === revision.current) accept(data.sessions);
    } catch {
      if (mounted.current && started === revision.current) setError('load');
    } finally { loading.current = false; }
  }, [accept]);
  const setPinned = useCallback((sessionId: string, pinned: boolean) => {
    if (pending.current.has(sessionId)) return;
    pending.current.add(sessionId);setPendingIds(new Set(pending.current));revision.current++;
    queue.current = queue.current.then(async () => {
      try {
        if (!mounted.current) return;
        const response = await api.user.setSessionPin(sessionId, pinned);const data = await response.json();
        if (!response.ok || !Array.isArray(data.sessions)) throw new Error('Pin save failed');
        if (mounted.current) accept(data.sessions);
      } catch { if (mounted.current) setError('save'); }
      finally { pending.current.delete(sessionId);if (mounted.current) setPendingIds(new Set(pending.current)); }
    });
  }, [accept]);
  useEffect(() => {
    mounted.current = true;void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(onFocus, 15_000);
    window.addEventListener('focus', onFocus);document.addEventListener('visibilitychange', onFocus);
    return () => { mounted.current = false;window.clearInterval(timer);window.removeEventListener('focus', onFocus);document.removeEventListener('visibilitychange', onFocus); };
  }, [refresh]);
  // Renames, archives and deletes already refresh the workspace's project rows.
  useEffect(() => { void refresh(); }, [projects, refresh]);
  const pinnedIds = useMemo(() => new Set(conversations.map(row => row.sessionId)), [conversations]);
  const value = useMemo(() => ({ conversations, pinnedIds, pendingIds, error, setPinned, refresh }), [conversations, pinnedIds, pendingIds, error, setPinned, refresh]);
  return <SessionPinsContext.Provider value={value}>{children}</SessionPinsContext.Provider>;
}

/** Sidebar rows and menus use the same confirmed pin state; standalone rows can omit the provider. */
export function useSessionPins() { return useContext(SessionPinsContext); }
