import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** ChatInterface keeps its live transcript and drafts mounted while the browser presents only the reading surface. */
export function useChatReadingMode(
  surfaceRef: RefObject<HTMLDivElement>,
  scrollRef: RefObject<HTMLDivElement>,
  isActive: boolean,
  sessionId: string | null,
) {
  // The page-only state provides the same reading layout when native fullscreen is unavailable.
  const [mode, setMode] = useState<'off' | 'opening' | 'fullscreen' | 'page'>('off');
  const active = useRef(false);
  const ownsFullscreen = useRef(false);
  const generation = useRef(0);
  const escapeUntil = useRef(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const position = useRef<{ top: number; anchor?: HTMLElement; offset: number } | null>(null);

  const rememberPosition = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const rows = container.querySelectorAll<HTMLElement>('.chat-transcript-content > [data-message-timestamp]');
    const anchor = Array.from(rows).find(row => row.getBoundingClientRect().bottom > top);
    position.current = { top: container.scrollTop, anchor, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
  }, [scrollRef]);

  const finish = useCallback(() => {
    if (!active.current) return;
    rememberPosition();
    active.current = false;
    ownsFullscreen.current = false;
    generation.current++;
    // Some browsers deliver Escape immediately after fullscreenchange.
    escapeUntil.current = Date.now() + 400;
    setMode('off');
  }, [rememberPosition]);

  const exit = useCallback(async () => {
    if (document.fullscreenElement === surfaceRef.current && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch {
        // Retain the exit control while the browser still owns this surface.
        if (document.fullscreenElement === surfaceRef.current) return;
      }
    }
    finish();
  }, [finish, surfaceRef]);

  const enter = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!surface || active.current) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousFocus.current?.blur();
    rememberPosition();
    active.current = true;
    const request = ++generation.current;
    setMode('opening');
    try {
      if (!surface.requestFullscreen) {
        setMode('page');
        return;
      }
      // Invoke synchronously from the click to preserve browser user activation.
      await surface.requestFullscreen({ navigationUI: 'hide' });
      if (request !== generation.current || !active.current) {
        if (document.fullscreenElement === surface) await document.exitFullscreen();
        return;
      }
      ownsFullscreen.current = true;
      setMode('fullscreen');
    } catch {
      if (request === generation.current && active.current) setMode('page');
    }
  }, [rememberPosition, surfaceRef]);

  const toggle = useCallback(() => { void (active.current ? exit() : enter()); }, [enter, exit]);
  const suppressTaskEscape = useCallback(() => active.current || Date.now() < escapeUntil.current, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    const onFullscreenChange = () => {
      if (document.fullscreenElement === surfaceRef.current && active.current) {
        ownsFullscreen.current = true;
        setMode('fullscreen');
      } else if (ownsFullscreen.current) finish();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !suppressTaskEscape()) return;
      event.preventDefault();
      event.stopPropagation();
      if (active.current) void exit();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown, true);
      active.current = false;
      generation.current++;
      if (surface && document.fullscreenElement === surface) void document.exitFullscreen().catch(() => {});
    };
  }, [exit, finish, suppressTaskEscape, surfaceRef]);

  useEffect(() => {
    if (!isActive) void exit();
    // A route change restores the workspace before showing another session.
    return () => { void exit(); };
  }, [isActive, sessionId, exit]);

  const isReading = mode !== 'off';
  useLayoutEffect(() => {
    if (!isReading || !surfaceRef.current) return;
    // Inert siblings keep hidden workspace controls out of keyboard navigation.
    const siblings = new Map<HTMLElement, boolean>();
    let current: HTMLElement = surfaceRef.current;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          siblings.set(sibling, sibling.hasAttribute('inert'));
          sibling.setAttribute('inert', '');
        }
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    return () => { for (const [element, inert] of siblings) if (!inert) element.removeAttribute('inert'); };
  }, [isReading, surfaceRef]);

  useLayoutEffect(() => {
    if (!position.current) return;
    const saved = position.current;
    const restore = () => {
      const container = scrollRef.current;
      if (!container) return;
      container.scrollTop = saved.anchor?.isConnected
        ? container.scrollTop + saved.anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset
        : saved.top;
    };
    restore();
    const frame = requestAnimationFrame(() => {
      restore();
      if (isReading) surfaceRef.current?.querySelector<HTMLElement>('[data-reading-toggle]')?.focus({ preventScroll: true });
      else previousFocus.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, isReading, scrollRef, surfaceRef]);

  return { isReading, pageOnly: mode === 'page', enter, exit, toggle, suppressTaskEscape };
}
