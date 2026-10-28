import { useLayoutEffect, useRef, useState } from 'react';

/** Bound Markdown work to roughly 30 frames per second. */
const TEXT_FRAME_INTERVAL_MS = 32;
/** A burst catches up within this time, including a provider's final snapshot. */
const MAX_REVEAL_DELAY_MS = 140;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Chat's Markdown renderer uses this for both delta streams and growing provider snapshots. */
export function useProgressiveText(content: string): string {
  // History appears in full on mount; only subsequent appended text is paced.
  const [displayed, setDisplayed] = useState(content);
  const displayedRef = useRef(content);
  const targetRef = useRef(content);
  const frameRef = useRef(0);
  const startedAtRef = useRef(0);
  const lastFrameRef = useRef(0);

  useLayoutEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const cancel = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
    const finish = () => {
      cancel();
      displayedRef.current = targetRef.current;
      setDisplayed(targetRef.current);
    };
    const onMotionChange = () => { if (motion?.matches) finish(); };
    motion?.addEventListener('change', onMotionChange);
    return () => { cancel(); motion?.removeEventListener('change', onMotionChange); };
  }, []);

  useLayoutEffect(() => {
    targetRef.current = content;
    if (content === displayedRef.current) return;
    if (!content.startsWith(displayedRef.current)
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      displayedRef.current = content;
      setDisplayed(content);
      return;
    }
    if (frameRef.current) return;
    startedAtRef.current = performance.now();
    lastFrameRef.current = 0;

    const tick = (now: number) => {
      if (now - lastFrameRef.current < TEXT_FRAME_INTERVAL_MS) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameRef.current = now;
      const target = targetRef.current;
      const remaining = target.length - displayedRef.current.length;
      let end = now - startedAtRef.current >= MAX_REVEAL_DELAY_MS
        ? target.length
        : displayedRef.current.length + Math.max(1, Math.ceil(remaining * 0.45));
      // Keep complete graphemes, including flags, skin tones and joined emoji.
      const start = displayedRef.current.length;
      if (end < target.length) {
        for (const segment of graphemeSegmenter.segment(target.slice(start))) {
          const boundary = start + segment.index + segment.segment.length;
          if (boundary >= end) { end = boundary; break; }
        }
      }
      displayedRef.current = target.slice(0, end);
      setDisplayed(displayedRef.current);
      frameRef.current = end < target.length ? requestAnimationFrame(tick) : 0;
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [content]);

  return content.startsWith(displayed) ? displayed : content;
}
