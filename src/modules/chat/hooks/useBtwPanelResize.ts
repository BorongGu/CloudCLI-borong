import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type PanelBounds = { left: number; top: number; width: number; height: number };
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type ResizeDrag = { pointerId: number; x: number; y: number; bounds: PanelBounds; direction: ResizeDirection; handle: HTMLElement; userSelect: string };

const VIEWPORT_MARGIN = 8;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;

function readViewport(): PanelBounds {
  const viewport = window.visualViewport;
  return {
    left: (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN,
    top: (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN,
    width: Math.max(1, (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN * 2),
    height: Math.max(1, (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN * 2),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function fitBounds(bounds: PanelBounds, viewport: PanelBounds): PanelBounds {
  const width = clamp(bounds.width, Math.min(MIN_WIDTH, viewport.width), viewport.width);
  const height = clamp(bounds.height, Math.min(MIN_HEIGHT, viewport.height), viewport.height);
  return {
    left: clamp(bounds.left, viewport.left, viewport.left + viewport.width - width),
    top: clamp(bounds.top, viewport.top, viewport.top + viewport.height - height),
    width, height,
  };
}

function resizeBounds(bounds: PanelBounds, direction: ResizeDirection, dx: number, dy: number): PanelBounds {
  const viewport = readViewport();
  const start = fitBounds(bounds, viewport);
  let { left, top } = start;
  let right = left + start.width;
  let bottom = top + start.height;
  const minWidth = Math.min(MIN_WIDTH, viewport.width);
  const minHeight = Math.min(MIN_HEIGHT, viewport.height);
  // Each dragged edge moves independently while the opposite edge stays anchored.
  if (direction.includes('w')) left = clamp(left + dx, viewport.left, right - minWidth);
  if (direction.includes('e')) right = clamp(right + dx, left + minWidth, viewport.left + viewport.width);
  if (direction.includes('n')) top = clamp(top + dy, viewport.top, bottom - minHeight);
  if (direction.includes('s')) bottom = clamp(bottom + dy, top + minHeight, viewport.top + viewport.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** BtwPanel uses pointer and keyboard resizing while retaining its preferred size across keyboard/viewport changes. */
export function useBtwPanelResize(windowKey: string) {
  const storageKey = `cloudcli-btw-bounds:${windowKey}`;
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  // A manual rectangle overrides the responsive default after the first resize.
  const [bounds, setBounds] = useState<PanelBounds | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(saved[key]))
        && saved.width > 0 && saved.height > 0) return saved;
    } catch { /* Responsive defaults remain available when storage is restricted. */ }
    return null;
  });
  // Visual viewport changes constrain the displayed rectangle while retaining the user's preferred size.
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    if (bounds) { try { sessionStorage.setItem(storageKey, JSON.stringify(bounds)); } catch {} }
  }, [bounds, storageKey]);

  useEffect(() => {
    const updateViewport = () => {
      const next = readViewport();
      setViewport(current => next.left === current.left && next.top === current.top
        && next.width === current.width && next.height === current.height ? current : next);
    };
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      document.body.style.userSelect = drag.userSelect;
      if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    };
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      setBounds(resizeBounds(drag.bounds, drag.direction, event.clientX - drag.x, event.clientY - drag.y));
    };
    const end = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) finish();
    };
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', finish);
    return () => {
      finish();
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('lostpointercapture', end);
      window.removeEventListener('blur', finish);
    };
  }, []);

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection) => {
    if (event.button !== 0 || event.isPrimary === false || !panelRef.current || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      bounds: panelRef.current.getBoundingClientRect(), direction, handle: event.currentTarget, userSelect: document.body.style.userSelect };
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const resizeWithKeyboard = useCallback((key: string, direction: ResizeDirection, largeStep: boolean) => {
    if (!panelRef.current || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return false;
    const step = largeStep ? 40 : 10;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    setBounds(resizeBounds(panelRef.current.getBoundingClientRect(), direction, dx, dy));
    return true;
  }, []);

  const clearSavedBounds = () => { try { sessionStorage.removeItem(storageKey); } catch {} };
  return { panelRef, bounds: bounds ? fitBounds(bounds, viewport) : null, startResize, resizeWithKeyboard, clearSavedBounds };
}
