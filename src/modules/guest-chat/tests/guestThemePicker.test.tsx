import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GuestThemePicker } from '@/modules/guest-chat/GuestThemePicker';

beforeEach(() => { localStorage.clear();delete document.documentElement.dataset.guestTheme;document.documentElement.classList.add('dark'); });
afterEach(() => { cleanup();vi.restoreAllMocks();delete document.documentElement.dataset.guestTheme;document.documentElement.classList.add('dark'); });

test('appearance choices persist across the login-to-chat remount and preserve workspace preferences', () => {
  localStorage.setItem('theme', 'dark');
  const page = render(<GuestThemePicker />);
  fireEvent.click(screen.getByRole('button', { name: '选择配色' }));
  fireEvent.click(screen.getByRole('button', { name: /奶油蛋糕/ }));
  expect(localStorage.getItem('guest-theme')).toBe('cream');expect(localStorage.getItem('theme')).toBe('dark');
  expect(document.documentElement.classList.contains('dark')).toBe(false);expect(document.documentElement.dataset.guestTheme).toBe('cream');
  expect(screen.queryByRole('group', { name: '界面配色' })).toBeNull();
  page.unmount();render(<GuestThemePicker />);expect(document.documentElement.dataset.guestTheme).toBe('cream');
  fireEvent.click(screen.getByRole('button', { name: '选择配色' }));fireEvent.click(screen.getByRole('button', { name: /暗黑/ }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);expect(localStorage.getItem('guest-theme')).toBe('dark');
});

test('the picker supports keyboard dismissal and follows changes from another tab', () => {
  render(<GuestThemePicker />);const trigger = screen.getByRole('button', { name: '选择配色' });
  fireEvent.click(trigger);expect(document.activeElement).toBe(screen.getByRole('button', { name: /暗黑/ }));
  fireEvent.keyDown(document, { key: 'Escape' });expect(trigger.getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(trigger);
  fireEvent(window, new StorageEvent('storage', { key: 'guest-theme', newValue: 'cream' }));expect(document.documentElement.dataset.guestTheme).toBe('cream');
  fireEvent.click(trigger);fireEvent.pointerDown(document.body);expect(screen.queryByRole('group')).toBeNull();
});

test('restricted browser storage still permits theme changes and a page-local remount', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage disabled'); });
  const page = render(<GuestThemePicker />);fireEvent.click(screen.getByRole('button', { name: '选择配色' }));fireEvent.click(screen.getByRole('button', { name: /奶油蛋糕/ }));
  page.unmount();render(<GuestThemePicker />);expect(document.documentElement.dataset.guestTheme).toBe('cream');
});
