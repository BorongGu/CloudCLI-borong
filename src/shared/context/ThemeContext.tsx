import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { AppearanceStyle, ThemeMode } from '@/shared/types';
import { APPEARANCE_STYLES } from '@/shared/constants';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  chatFontSize: string;
  setChatFontSize: (size: string) => void;
  appearanceStyle: AppearanceStyle;
  setAppearanceStyle: (style: AppearanceStyle) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the stored preference as a theme mode.
 *
 * Only `'dark'` and `'light'` were ever written before the system option
 * existed, so anything else — `'system'`, an absent value, or a value a newer
 * client wrote — means "follow the OS", which is also the default.
 */
const readStoredThemeMode = (): ThemeMode => {
  const savedTheme = readUserPreference<string | null>('theme', null);
  return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'system';
};

/** A saved chat size is an integer pixel value; `theme` uses the current appearance's type scale. */
const normalizeChatFontSize = (value: unknown): string => {
  const size = Number(value);
  return Number.isInteger(size) && size >= 8 && size <= 24 ? String(size) : 'theme';
};

const readStoredChatFontSize = (): string => normalizeChatFontSize(readUserPreference('chatFontSize', 'theme'));

const isAppearanceStyle = (value: unknown): value is AppearanceStyle => APPEARANCE_STYLES.some(style => style === value);

/** Browser chrome follows each style's canvas while light/dark remains a separate preference. */
const APPEARANCE_CANVAS: Record<AppearanceStyle, { light: string; dark: string }> = {
  claude: { light: '#faf9f5', dark: '#1c1b19' },
  github: { light: '#ffffff', dark: '#0d1117' },
  linear: { light: '#fcfcfd', dark: '#191a1d' },
  paper: { light: '#f4f0e7', dark: '#26231f' },
  raycast: { light: '#f5f5f7', dark: '#080a0d' },
};

/** Existing accounts keep their Claude/GitHub choice until they explicitly select a named style. */
const readStoredAppearanceStyle = (): AppearanceStyle => {
  const saved = readUserPreference<unknown>('appearanceStyle', null);
  if (isAppearanceStyle(saved)) return saved;
  return readStoredUiPreferences().githubAppearance ? 'github' : 'claude';
};

/** Whether the OS currently asks for a dark appearance; false when unknown. */
const prefersDarkAppearance = (): boolean =>
  Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);

/** The colour a mode resolves to right now. */
const resolveIsDarkMode = (mode: ThemeMode): boolean =>
  mode === 'system' ? prefersDarkAppearance() : mode === 'dark';

/** Standalone renderers such as guest-chat diagrams can fall back to their document theme. */
export const useOptionalTheme = () => useContext(ThemeContext);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Mounted once by App; Settings uses useTheme to choose the appearance and account-synced chat type size. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  // The mode the user chose, not the colour it currently resolves to: only the
  // mode is persisted, and `system` has to keep tracking the OS afterwards.
  // Read synchronously from the preference mirror so the very first paint is
  // already the right colour.
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredThemeMode);
  // The resolved colour. It is not derivable from `themeMode` alone, because
  // under `system` it changes when the OS does, with no state change here.
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDarkMode(readStoredThemeMode()));
  // The saved interface style travels with the account and applies before the first workspace paint.
  const [appearanceStyle, setAppearanceStyleState] = useState<AppearanceStyle>(readStoredAppearanceStyle);
  // Apply the account's chat type size before painting, then follow local and remote preference changes.
  const [chatFontSize, setChatFontSizeState] = useState(readStoredChatFontSize);

  // The theme now lives in auth.db, so a change made on another device (or in
  // another tab) arrives through the preference store rather than a re-render.
  useEffect(() => subscribeToUserPreferences(() => {
    const storedMode = readStoredThemeMode();
    setThemeModeState(storedMode);
    setIsDarkMode(resolveIsDarkMode(storedMode));
    setAppearanceStyleState(readStoredAppearanceStyle());
    setChatFontSizeState(readStoredChatFontSize());
  }), []);

  // Applying the theme to the document and persisting it are deliberately
  // separate. Persisting from here would also fire on mount — before the stored
  // theme had been fetched — writing this device's system default over the
  // theme the user actually chose on another one.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    document.documentElement.dataset.appearance = appearanceStyle;
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
      ?.setAttribute('content', isDarkMode ? 'black-translucent' : 'default');
    const canvas = APPEARANCE_CANVAS[appearanceStyle][isDarkMode ? 'dark' : 'light'];
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas);
  }, [appearanceStyle, isDarkMode]);

  useLayoutEffect(() => {
    if (chatFontSize === 'theme') document.documentElement.style.removeProperty('--chat-font-size');
    else document.documentElement.style.setProperty('--chat-font-size', `${chatFontSize}px`);
  }, [chatFontSize]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Re-read rather than close over `themeMode`: a change that arrived from
      // another device lands in the store first, and only `system` follows the OS.
      if (readStoredThemeMode() === 'system') {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // The only writer: a theme is stored because the user picked it, never
  // because this device happened to start on one.
  const setThemeMode = useCallback((mode: ThemeMode) => {
    writeUserPreference('theme', mode);
    setThemeModeState(mode);
    setIsDarkMode(resolveIsDarkMode(mode));
  }, []);

  const setChatFontSize = useCallback((size: string) => {
    const value = normalizeChatFontSize(size);
    writeUserPreference('chatFontSize', value);
    setChatFontSizeState(value);
  }, []);

  const setAppearanceStyle = useCallback((style: AppearanceStyle) => {
    if (!isAppearanceStyle(style)) return;
    writeUserPreference('appearanceStyle', style);
    setAppearanceStyleState(style);
  }, []);

  // Kept for the callers that only offer a light/dark switch: choosing either
  // one is an explicit choice, so it leaves `system` behind exactly as before.
  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((previous) => {
      const next = !previous;
      writeUserPreference('theme', next ? 'dark' : 'light');
      setThemeModeState(next ? 'dark' : 'light');
      return next;
    });
  }, []);

  // A fresh object here would re-render every consumer in the app on any
  // render of this provider, theme change or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ isDarkMode, toggleDarkMode, themeMode, setThemeMode, chatFontSize, setChatFontSize, appearanceStyle, setAppearanceStyle }),
    [isDarkMode, toggleDarkMode, themeMode, setThemeMode, chatFontSize, setChatFontSize, appearanceStyle, setAppearanceStyle],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
