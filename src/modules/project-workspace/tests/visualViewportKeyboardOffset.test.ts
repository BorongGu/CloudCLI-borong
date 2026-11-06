import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

let viewport: EventTarget & { height: number; scale: number };
let nextFrame: FrameRequestCallback | null;
const height = () => document.documentElement.style.getPropertyValue('--keyboard-height');
const flushFrame = () => act(() => { const callback = nextFrame; nextFrame = null; callback?.(16); });
const resize = (value: number) => { viewport.height = value; viewport.dispatchEvent(new Event('resize')); };

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: 800, scale: 1 });
  nextFrame = null;
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = null; });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('mobile viewport keyboard offset', () => {
  it('keeps reading geometry fixed as browser chrome changes the visual viewport', () => {
    renderHook(useVisualViewportKeyboardOffset);
    flushFrame();
    for (const value of [790.25, 752.5, 721, 680]) {
      resize(value); flushFrame();
      expect(height()).toBe('0px');
    }
  });

  it('raises the composer for a focused text field and clears the offset when the keyboard closes', () => {
    const input = document.createElement('textarea'); document.body.append(input);
    renderHook(useVisualViewportKeyboardOffset);
    input.focus(); resize(480.4); flushFrame();
    expect(height()).toBe('320px');
    resize(800); flushFrame();
    expect(height()).toBe('0px');
  });

  it('ignores toolbar-sized changes and pinch zoom even when an input retains focus', () => {
    const input = document.createElement('input'); document.body.append(input);
    renderHook(useVisualViewportKeyboardOffset);
    input.focus(); resize(752.4); flushFrame();
    expect(height()).toBe('0px');
    viewport.scale = 1.5; resize(480); flushFrame();
    expect(height()).toBe('0px');
  });

  it('clears a stale keyboard inset on blur before the next viewport resize', () => {
    const input = document.createElement('textarea'); document.body.append(input);
    renderHook(useVisualViewportKeyboardOffset);
    input.focus(); resize(480); flushFrame();
    expect(height()).toBe('320px');
    input.blur(); flushFrame();
    expect(height()).toBe('0px');
  });

  it('coalesces resize events and skips equal rounded heights', () => {
    const input = document.createElement('textarea'); document.body.append(input);
    renderHook(useVisualViewportKeyboardOffset);
    input.focus(); resize(480); flushFrame();
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    resize(480.1); resize(480.2); flushFrame();
    expect(setProperty).not.toHaveBeenCalled();
    resize(470); resize(460); flushFrame();
    expect(setProperty).toHaveBeenCalledExactlyOnceWith('--keyboard-height', '340px');
  });
});
