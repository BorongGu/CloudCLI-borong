import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { api } from '@/shared/api';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionMessages: vi.fn(), sessionTokenUsage: vi.fn(async () => ({ ok: false })),
} } }));
const project = { projectId: 'project', path: '/repo' } as Project;
const session = { id: 'session' } as ProjectSession;
const stable = { selectedProject: project, ws: null, sendMessage: vi.fn(),
  resetStreamingState: vi.fn(), statusCheckSentAtRef: { current: new Map() }, lastSeqRef: { current: new Map() } };
const rows = Array.from({ length: 500 }, (_, index): NormalizedMessage => ({
  id: `message-${index}`, sessionId: 'session', provider: 'codex', kind: 'text',
  role: 'assistant', content: `message ${index}`, timestamp: new Date(1700000000000 + index * 1000).toISOString(),
}));
const response = (messages: NormalizedMessage[], hasMore: boolean) => ({
  ok: true, json: async () => ({ data: { messages, hasMore, total: 500 } }),
} as Response);

function setup() {
  let committedCount = 0;
  const view = renderHook(({ selectedSession }: { selectedSession: ProjectSession }) => {
    const store = useSessionStore();
    const chat = useChatSessionState({ ...stable, isActive: true, selectedSession, sessionStore: store });
    committedCount = chat.visibleMessages.length;
    return { ...chat, store };
  }, { initialProps: { selectedSession: session } });
  const container = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.setAttribute('data-message-timestamp', rows[415].timestamp);
  container.appendChild(anchor);
  document.body.appendChild(container);
  Object.defineProperties(container, {
    clientHeight: { value: 500 },
    scrollHeight: { get: () => committedCount * 100 },
  });
  // The stable row moves downward as older rows commit, exactly as in a real prepend.
  anchor.getBoundingClientRect = () => ({ top: 1500 + (committedCount - 100) * 100 - container.scrollTop,
    bottom: 1600 + (committedCount - 100) * 100 - container.scrollTop } as DOMRect);
  (view.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  return { ...view, container, anchor };
}

beforeEach(() => {
  vi.mocked(api.providers.sessionMessages).mockReset();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('continuous upward history browsing', () => {
  it('loads 100 initially, prefetches before the top and retains the reader position at response time', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(400), true));
    let resolvePage!: (value: Response) => void;
    vi.mocked(api.providers.sessionMessages).mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const { result, container, anchor } = setup();
    await waitFor(() => expect(result.current.visibleMessages.length).toBe(100));
    expect(api.providers.sessionMessages).toHaveBeenNthCalledWith(1, 'session', { limit: 100, offset: 0 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    container.scrollTop = 1400;
    act(() => result.current.handleScroll());
    await waitFor(() => expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2));
    expect(api.providers.sessionMessages).toHaveBeenNthCalledWith(2, 'session', { limit: 100, offset: 100 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // The reader keeps moving upward while the request is in flight.
    container.scrollTop = 900;
    act(() => result.current.handleScroll());
    const offset = anchor.getBoundingClientRect().top;
    await act(async () => { resolvePage(response(rows.slice(300, 400), true)); });
    expect(result.current.visibleMessages.length).toBe(200);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    expect(container.scrollTop).toBe(10900);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('automatically reveals cached older rows with a stable anchor', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(200), false));
    const { result, container, anchor } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(300));
    expect(result.current.visibleMessages.length).toBe(100);
    container.scrollTop = 1200;
    const offset = anchor.getBoundingClientRect().top;
    act(() => result.current.handleScroll());
    expect(result.current.visibleMessages.length).toBe(200);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps a delayed old-session page from changing the newly selected session', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(400), true));
    let resolvePage!: (value: Response) => void;
    vi.mocked(api.providers.sessionMessages).mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const { result, rerender, container } = setup();
    await waitFor(() => expect(result.current.visibleMessages.length).toBe(100));
    container.scrollTop = 1200;
    act(() => result.current.handleScroll());
    await waitFor(() => expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2));
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(499), false));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(false));
    await act(async () => { resolvePage(response(rows.slice(300, 400), true)); });
    expect(result.current.currentSessionId).toBe('other-session');
    expect(result.current.hasMoreMessages).toBe(false);
    expect(result.current.visibleMessageCount).toBe(100);
  });
});

describe('recent session reading positions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('restores the cached history window and reading anchor after a brief session switch', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(200), false));
    const { result, rerender, container, anchor } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(300));
    container.scrollTop = 1200;
    act(() => result.current.handleScroll());
    const savedTop = container.scrollTop;
    const savedOffset = anchor.getBoundingClientRect().top;
    expect(result.current.visibleMessageCount).toBe(200);

    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(499), false));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    rerender({ selectedSession: session });
    await waitFor(() => expect(result.current.visibleMessageCount).toBe(200));
    expect(result.current.isUserScrolledUp).toBe(true);
    expect(container.scrollTop).toBe(savedTop);
    expect(anchor.getBoundingClientRect().top).toBe(savedOffset);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('restores between sessions with equal page sizes and equal scrolled-up state', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(400), true));
    const { result, rerender, container } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(100));
    container.scrollTop = 4000;
    act(() => result.current.handleScroll());
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(400), true));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.store.getSessionSlot('other-session')?.fetchedAt).toBeTruthy());
    container.scrollTop = 7000;
    act(() => result.current.handleScroll());
    rerender({ selectedSession: session });
    await waitFor(() => expect(result.current.currentSessionId).toBe('session'));
    expect(container.scrollTop).toBe(4000);
    expect(result.current.isUserScrolledUp).toBe(true);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('retains the saved anchor when a stale-session refresh brings newer replies', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(200), true));
    const { result, rerender, container, anchor } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(300));
    container.scrollTop = 1200;
    act(() => result.current.handleScroll());
    const savedOffset = anchor.getBoundingClientRect().top;
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(499), false));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const newer = Array.from({ length: 10 }, (_, index) => ({
      ...rows[499], id: `new-${index}`, content: `new reply ${index}`,
      timestamp: new Date(1700000500000 + index * 1000).toISOString(),
    }));
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { messages: [...rows.slice(490), ...newer], total: 510, hasMore: true } }),
    } as Response);
    rerender({ selectedSession: session });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(310));
    expect(result.current.visibleMessageCount).toBe(210);
    expect(anchor.getBoundingClientRect().top).toBe(savedOffset);
    expect(result.current.isUserScrolledUp).toBe(true);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(3);
  });

  it('expires the saved position after 30 minutes and reopens the latest page', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(200), false));
    const { result, rerender, container } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(300));
    container.scrollTop = 1200;
    act(() => result.current.handleScroll());
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(499), false));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(400), true));
    rerender({ selectedSession: session });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(100));
    expect(result.current.visibleMessageCount).toBe(100);
    expect(result.current.isUserScrolledUp).toBe(false);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(3);
  });

  it('keeps a saved bottom view following replies received while another session is open', async () => {
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(200), false));
    const { result, rerender, container } = setup();
    await waitFor(() => expect(result.current.chatMessages.length).toBe(300));
    container.scrollTop = container.scrollHeight - 500;
    act(() => result.current.handleScroll());
    vi.mocked(api.providers.sessionMessages).mockResolvedValueOnce(response(rows.slice(499), false));
    rerender({ selectedSession: { id: 'other-session' } as ProjectSession });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    act(() => result.current.store.appendRealtime('session', {
      ...rows[499], id: 'new-answer', content: 'new reply', timestamp: new Date().toISOString(),
    }));
    rerender({ selectedSession: session });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(301));
    expect(result.current.visibleMessageCount).toBe(101);
    expect(result.current.isUserScrolledUp).toBe(false);
    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(api.providers.sessionMessages).toHaveBeenCalledTimes(2);
  });
});
