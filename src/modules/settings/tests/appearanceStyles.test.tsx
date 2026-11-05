import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.appearance;
  document.documentElement.style.removeProperty('--chat-font-size');
});

test('all five styles can be selected by their visible labels and keep dark mode plus the chosen text size', () => {
  writeUserPreference('theme', 'dark');
  writeUserPreference('chatFontSize', '9');
  render(<ThemeProvider><UiPreferencesProvider>
    <AppearanceSettingsTab
      projectSortOrder="name" onProjectSortOrderChange={() => {}}
      codeEditorSettings={{ wordWrap: false, showMinimap: true, lineNumbers: true, fontSize: '14' }}
      onCodeEditorWordWrapChange={() => {}} onCodeEditorShowMinimapChange={() => {}}
      onCodeEditorLineNumbersChange={() => {}} onCodeEditorFontSizeChange={() => {}}
    />
  </UiPreferencesProvider></ThemeProvider>);

  assert.equal(screen.getAllByRole('radio').length, 5);
  for (const [name, style, font] of [
    ['Paper', 'paper', /Newsreader/],
    ['Raycast', 'raycast', /IBM Plex Sans SC/],
    ['Linear', 'linear', /Manrope/],
  ] as const) {
    fireEvent.click(screen.getByRole('radio', { name }));
    assert.equal(document.documentElement.dataset.appearance, style);
    assert.equal(readUserPreference('appearanceStyle', null), style);
    assert.ok(screen.getByText(font));
    assert.ok(document.documentElement.classList.contains('dark'));
    assert.equal(document.documentElement.style.getPropertyValue('--chat-font-size'), '9px');
  }
});
