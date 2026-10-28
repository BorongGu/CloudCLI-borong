import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProgressiveText } from '@/modules/chat/hooks/useProgressiveText';

let now = 0;
let nextId = 0;
const frames = new Map<number, FrameRequestCallback>();
const advanceFrame = (ms = 32) => act(() => {
  now += ms;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(now));
});

beforeEach(() => {
  now = 0; nextId = 0; frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback); return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('progressive assistant text', () => {
  it('shows history immediately, then fills an appended native snapshot in bounded frames', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), {
      initialProps: { content: '已有历史。' },
    });
    expect(result.current).toBe('已有历史。');
    const full = '已有历史。新增的中文回复逐渐呈现，保持最终内容完整。';
    rerender({ content: full });
    expect(result.current).toBe('已有历史。');
    advanceFrame();
    expect(result.current.length).toBeGreaterThan(5);
    expect(result.current.length).toBeLessThan(full.length);
    advanceFrame(140);
    expect(result.current).toBe(full);
    expect(frames.size).toBe(0);
  });

  it('coalesces a burst, preserves joined emoji and catches up after a background-tab pause', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    const full = '👩🏽‍💻👨‍👩‍👧‍👦e\u0301'.repeat(100);
    rerender({ content: full.slice(0, 100) });
    rerender({ content: full });
    expect(frames.size).toBe(1);
    advanceFrame();
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(full)];
    const boundaries = segments.map(segment => segment.index);
    expect(boundaries).toContain(result.current.length);
    advanceFrame(1000);
    expect(result.current).toBe(full);
  });

  it('replaces edited content immediately and cancels its old scheduled frames', () => {
    const { result, rerender, unmount } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: 'old' } });
    rerender({ content: 'old appended reply' });
    expect(frames.size).toBe(1);
    rerender({ content: 'replacement' });
    expect(result.current).toBe('replacement');
    expect(frames.size).toBe(0);
    rerender({ content: 'replacement more' });
    unmount();
    expect(frames.size).toBe(0);
  });

  it('respects reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: 'a' } });
    rerender({ content: 'a whole response' });
    expect(result.current).toBe('a whole response');
    expect(frames.size).toBe(0);
  });
});
