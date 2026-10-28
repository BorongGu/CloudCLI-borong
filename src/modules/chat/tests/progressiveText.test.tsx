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
  it('shows history immediately, then reveals an appended snapshot at an even pace', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), {
      initialProps: { content: '已有历史。' },
    });
    expect(result.current).toBe('已有历史。');
    const full = '已有历史。新增的中文回复逐渐呈现，保持最终内容完整。';
    rerender({ content: full });
    expect(result.current).toBe('已有历史。');
    advanceFrame();
    expect(result.current).toBe('已有历史。');
    advanceFrame(64);
    expect(result.current.length).toBeGreaterThan(5);
    expect(result.current.length).toBeLessThan(full.length);
    for (let i = 0; i < 30; i++) advanceFrame();
    expect(result.current).toBe(full);
    expect(frames.size).toBe(0);
  });

  it('coalesces a burst, preserves joined emoji and catches up after a background-tab pause', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    const full = '👩🏽‍💻👨‍👩‍👧‍👦e\u0301'.repeat(100);
    rerender({ content: full.slice(0, 100) });
    rerender({ content: full });
    expect(frames.size).toBe(1);
    advanceFrame(96);
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(full)];
    const boundaries = segments.map(segment => segment.index);
    expect(boundaries).toContain(result.current.length);
    advanceFrame(1000);
    expect(result.current).toBe(full);
  });

  it('uses equal-sized steps through a burst instead of slowing down then flushing its tail', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    const full = '字'.repeat(320);rerender({ content: full });
    const steps: number[] = [];
    for (let i = 0; i < 28; i++) {
      const before = result.current.length;advanceFrame();
      if (result.current.length > before) steps.push(result.current.length - before);
    }
    expect(result.current).toBe(full);
    // First/last steps may cover a fraction of an interval; the middle stays uniform.
    const middle = steps.slice(1, -1);
    expect(middle.length).toBeGreaterThan(12);
    expect(Math.max(...middle) - Math.min(...middle)).toBeLessThanOrEqual(1);
    expect(Math.max(...steps)).toBeLessThan(20);
    expect(frames.size).toBe(0);
  });

  it('absorbs irregular native packets without a deadline flush or a sudden per-frame jump', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    let content = '字'.repeat(40);rerender({ content });
    const arrivals = new Map([[2, 20], [5, 80], [8, 10], [11, 70], [15, 30], [19, 80]]);
    const steps: number[] = [];
    for (let frame = 1; frame <= 65; frame++) {
      const added = arrivals.get(frame);
      if (added) { content += '字'.repeat(added);rerender({ content }); }
      const before = result.current.length;advanceFrame();
      steps.push(result.current.length - before);
    }
    expect(result.current).toBe(content);
    expect(Math.max(...steps)).toBeLessThanOrEqual(16);
    // Packet boundaries change throughput gradually, rather than dumping their first half.
    const finishedAt = steps.findIndex((step, index) => index > 20 && step === 0);
    const flowing = steps.slice(3, finishedAt - 1);
    expect(flowing.length).toBeGreaterThan(18);
    expect(Math.max(...flowing.map((step, index) => index ? Math.abs(step - flowing[index - 1]) : 0))).toBeLessThanOrEqual(2);
  });

  it('keeps sub-character credit for a slow stream and finishes the entire final tail', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    let content = '';
    for (let i = 0; i < 10; i++) {
      content += '慢';rerender({ content });
      for (let frame = 0; frame < 5; frame++) advanceFrame();
      expect(result.current.length).toBeLessThanOrEqual(content.length);
    }
    for (let frame = 0; frame < 35; frame++) advanceFrame();
    expect(result.current).toBe(content);expect(frames.size).toBe(0);
  });

  it('limits catch-up after a busy browser frame while resuming immediately after a background pause', () => {
    const { result, rerender } = renderHook(({ content }) => useProgressiveText(content), { initialProps: { content: '' } });
    const content = '字'.repeat(320);rerender({ content });advanceFrame(96);
    const before = result.current.length;advanceFrame(250);
    expect(result.current.length - before).toBeLessThan(40);
    expect(result.current.length).toBeLessThan(content.length);
    advanceFrame(1000);expect(result.current).toBe(content);expect(frames.size).toBe(0);
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
