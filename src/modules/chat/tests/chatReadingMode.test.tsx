import { useRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatReadingMode } from '@/modules/chat/hooks/useChatReadingMode';
import { getOverlayContainer } from '@/shared/utils';

let fullscreen: Element | null;
let request: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.fn>;

function enterNativeFullscreen(element: Element) {
  fullscreen = element;
  document.dispatchEvent(new Event('fullscreenchange'));
}

function Harness({ sessionId = 'one', active = true }: { sessionId?: string; active?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const reading = useChatReadingMode(surface, scroll, active, sessionId);
  return <><aside data-testid="sidebar">Sessions</aside><div ref={surface} data-testid="surface" data-chat-reading-mode={reading.isReading ? 'true' : undefined}>
    <div ref={scroll} data-testid="scroll">Transcript</div>
    <div hidden={reading.isReading}><textarea defaultValue="retained draft" aria-label="draft" /></div>
    <button data-reading-toggle onClick={reading.toggle}>{reading.isReading ? 'exit' : 'enter'}</button>
    <output>{reading.isReading ? (reading.pageOnly ? 'page' : 'reading') : 'off'}</output>
  </div></>;
}

beforeEach(() => {
  fullscreen = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  request = vi.fn(function (this: HTMLElement) {
    enterNativeFullscreen(this);
    return Promise.resolve();
  });
  leave = vi.fn(() => {
    fullscreen = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: leave });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
  Reflect.deleteProperty(document, 'fullscreenElement');
  vi.restoreAllMocks();
});

test('reading requests native fullscreen, retains scroll and draft, and places overlays in the fullscreen surface', async () => {
  const view = render(<Harness />);
  const scroll = view.getByTestId('scroll');
  const draft = view.getByLabelText('draft');
  scroll.scrollTop = 320;
  fireEvent.click(view.getByText('enter'));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' }));
  expect(fullscreen).toBe(view.getByTestId('surface'));
  expect(getOverlayContainer()).toBe(fullscreen);
  expect(view.getByTestId('sidebar').hasAttribute('inert')).toBe(true);
  expect(scroll.scrollTop).toBe(320);
  expect(draft.parentElement?.hidden).toBe(true);
  scroll.scrollTop = 650;
  fireEvent.click(view.getByText('exit'));
  await waitFor(() => expect(view.getByText('off')).toBeTruthy());
  expect(scroll.scrollTop).toBe(650);
  expect(view.getByLabelText('draft')).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('retained draft');
  expect(draft.parentElement?.hidden).toBe(false);
  expect(view.getByTestId('sidebar').hasAttribute('inert')).toBe(false);
  expect(getOverlayContainer()).toBe(document.body);
});

test('Escape exits reading before the task-abort shortcut, including a native exit followed by Escape', async () => {
  const view = render(<Harness />);
  const abortTask = vi.fn();
  document.addEventListener('keydown', abortTask, true);
  try {
    fireEvent.click(view.getByText('enter'));
    await waitFor(() => expect(fullscreen).toBe(view.getByTestId('surface')));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(fullscreen).toBeNull());
    expect(abortTask).toHaveBeenCalledTimes(0);
    fireEvent.click(view.getByText('enter'));
    await act(async () => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(abortTask).toHaveBeenCalledTimes(0);
    expect(view.getByText('off')).toBeTruthy();
  } finally { document.removeEventListener('keydown', abortTask, true); }
});

test.each(['unsupported', 'rejected'])('page reading remains usable when fullscreen is %s', async reason => {
  if (reason === 'unsupported') Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  else request.mockRejectedValue(new Error('fullscreen denied'));
  const view = render(<Harness />);
  fireEvent.click(view.getByText('enter'));
  await waitFor(() => expect(view.getByText('page')).toBeTruthy());
  expect(getOverlayContainer()).toBe(view.getByTestId('surface'));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(view.getByText('off')).toBeTruthy());
});

test('changing sessions exits reading and a late native request cannot re-enter it', async () => {
  let resolve!: () => void;
  request.mockImplementation(function (this: HTMLElement) {
    return new Promise<void>(done => { resolve = () => { enterNativeFullscreen(this); done(); }; });
  });
  const view = render(<Harness sessionId="one" />);
  fireEvent.click(view.getByText('enter'));
  view.rerender(<Harness sessionId="two" />);
  await act(async () => { resolve(); });
  expect(fullscreen).toBeNull();
  expect(leave).toHaveBeenCalledTimes(1);
  expect(view.getByText('off')).toBeTruthy();
});
