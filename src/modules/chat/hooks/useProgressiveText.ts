import { useLayoutEffect, useRef, useState } from 'react';

/** Bound Markdown work to roughly 30 frames per second. */
const TEXT_FRAME_INTERVAL_MS = 32;
/** Collect adjacent packets before beginning a continuous reveal. */
const START_BUFFER_MS = 80;
/** A burst establishes a steady pace instead of draining a percentage each frame. */
const TARGET_BUFFER_SECONDS = 0.65;
const RATE_RESPONSE_MS = 450;
const DEFAULT_GRAPHEMES_PER_SECOND = 80;
const MIN_GRAPHEMES_PER_SECOND = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Chat's Markdown renderer uses this for both delta streams and growing provider snapshots. */
export function useProgressiveText(content: string): string {
  // History appears in full on mount; only subsequent appended text is paced.
  const [displayed, setDisplayed] = useState(content);
  // Keep the unread queue, fractional glyph budget and arrival estimate across frames.
  const playback = useRef({
    target: content, visible: content, ends: [] as number[], cursor: 0, frame: 0,
    readyAt: 0, lastFrame: 0, credit: 0,
    rate: DEFAULT_GRAPHEMES_PER_SECOND, targetRate: DEFAULT_GRAPHEMES_PER_SECOND,
    inputRate: DEFAULT_GRAPHEMES_PER_SECOND, sampleAt: 0, lastArrival: null as number | null, arrived: 0,
  });

  useLayoutEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const state = playback.current;
    const cancel = () => {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
    const finish = () => {
      cancel();
      state.visible = state.target;state.ends = [];state.cursor = 0;state.credit = 0;
      setDisplayed(state.visible);
    };
    const onMotionChange = () => { if (motion?.matches) finish(); };
    motion?.addEventListener('change', onMotionChange);
    return () => { cancel(); motion?.removeEventListener('change', onMotionChange); };
  }, []);

  useLayoutEffect(() => {
    const state = playback.current;
    state.target = content;
    if (content === state.visible) {
      cancelAnimationFrame(state.frame);
      Object.assign(state, { frame: 0, ends: [], cursor: 0, credit: 0 });
      return;
    }
    if (!content.startsWith(state.visible)
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(state.frame);
      Object.assign(state, { frame: 0, visible: content, ends: [], cursor: 0, credit: 0 });
      setDisplayed(content);
      return;
    }
    const previousRemaining = state.ends.length - state.cursor;
    const start = state.visible.length;
    // Segment just the unread tail once per packet, rather than the whole queue every frame.
    state.ends = Array.from(graphemeSegmenter.segment(content.slice(start)), segment => start + segment.index + segment.segment.length);
    state.cursor = 0;
    const now = performance.now();
    const elapsed = now - state.sampleAt;
    if (state.lastArrival === null || now - state.lastArrival > 1500) { state.sampleAt = now;state.arrived = 0; }
    else {
      state.arrived += Math.max(0, state.ends.length - previousRemaining);
      if (elapsed >= 120) {
        const incomingRate = state.arrived * 1000 / elapsed;
        state.inputRate = state.inputRate * 0.75 + incomingRate * 0.25;
        state.sampleAt = now;state.arrived = 0;
      }
    }
    state.lastArrival = now;
    state.targetRate = Math.max(MIN_GRAPHEMES_PER_SECOND, state.inputRate, state.ends.length / TARGET_BUFFER_SECONDS);
    if (state.frame) return;
    state.readyAt = now + START_BUFFER_MS;state.lastFrame = now;state.credit = 0;
    state.rate = state.targetRate;

    const tick = (now: number) => {
      if (now < state.readyAt || now - state.lastFrame < TEXT_FRAME_INTERVAL_MS) {
        state.frame = requestAnimationFrame(tick);
        return;
      }
      const paused = now - state.lastFrame >= 1000;
      const dt = Math.min(64, now - Math.max(state.lastFrame, state.readyAt));
      state.lastFrame = now;
      // Adapt to provider throughput gradually; keep this rate through the tail of a burst.
      state.rate += (state.targetRate - state.rate) * (1 - Math.exp(-dt / RATE_RESPONSE_MS));
      state.credit += state.rate * dt / 1000;
      const count = paused ? state.ends.length - state.cursor : Math.floor(state.credit);
      if (count > 0) {
        state.cursor = Math.min(state.ends.length, state.cursor + count);
        state.credit -= count;
        state.visible = state.target.slice(0, state.ends[state.cursor - 1]);
        setDisplayed(state.visible);
      }
      state.frame = state.cursor < state.ends.length ? requestAnimationFrame(tick) : 0;
      if (!state.frame) { state.ends = [];state.cursor = 0;state.credit = 0; }
    };
    state.frame = requestAnimationFrame(tick);
  }, [content]);

  return content.startsWith(displayed) ? displayed : content;
}
