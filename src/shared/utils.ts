import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { Project, ProjectSession, QuickSettingsTab, ServerEvent, SlashCommand } from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

// ---------------------------

//----------------- SESSION COMPLETION STATE ------------

const SESSION_COMPLETION_STORAGE_KEY = 'cloudcli-completed-sessions';
const MAX_SESSION_COMPLETIONS = 1000;

// Persist terminal outcomes so sidebar checks survive reloads, with one mirror shared by all rows.
let completionCachedRaw: string | null | undefined;
// Successful session ids are the observable completion snapshot shared by sidebar rows.
let completedSessionIds = new Set<string>();
// Completion instants distinguish a new run from a poll that began before the previous run finished.
let completionTimes = new Map<string, number>();
// Native terminal identities keep an acknowledged reply clear when the same event is replayed.
let completionKeys = new Map<string, string>();
// Read receipts survive reloads and travel to other tabs through the same storage snapshot.
let completionReads = new Map<string, { at: number; eventKey?: string }>();
// Output and errors belong to the current turn and are discarded at its terminal event.
const completionOutput = new Set<string>();
// An error blocks completion until a successful recovery produces output or an explicit success event.
const completionFailures = new Set<string>();
// Completion subscribers update only rows whose boolean snapshot actually changed.
const completionListeners = new Set<() => void>();

function readSessionCompletions() {
  try {
    const raw = localStorage.getItem(SESSION_COMPLETION_STORAGE_KEY);
    if (raw !== completionCachedRaw) {
      completionCachedRaw = raw;
      const value: unknown = JSON.parse(raw || '[]');
      const snapshot = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      const unread = snapshot?.unread ?? value;
      const entries: [string, number, string?][] = Array.isArray(unread) ? unread.flatMap(entry => {
        if (typeof entry === 'string') return [[entry, 0] as [string, number]];
        return Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])
          ? [[entry[0], entry[1], typeof entry[2] === 'string' ? entry[2] : undefined] as [string, number, string?]] : [];
      }).slice(-MAX_SESSION_COMPLETIONS) : [];
      completionTimes = new Map(entries.map(([id, at]) => [id, at]));
      completedSessionIds = new Set(completionTimes.keys());
      completionReads = new Map(Array.isArray(snapshot?.read) ? snapshot.read.filter(entry => Array.isArray(entry)
        && typeof entry[0] === 'string' && Number.isFinite(entry[1]?.at)).slice(-MAX_SESSION_COMPLETIONS) : []);
      completionKeys = new Map();
      for (const [id, receipt] of completionReads) if (typeof receipt.eventKey === 'string') completionKeys.set(id, receipt.eventKey);
      for (const [id, , eventKey] of entries) if (eventKey) completionKeys.set(id, eventKey);
    }
  } catch { /* Current-page outcomes remain available when storage is restricted. */ }
  return completedSessionIds;
}

function publishSessionCompletions() {
  completedSessionIds = new Set([...completedSessionIds].slice(-MAX_SESSION_COMPLETIONS));
  completionTimes = new Map([...completedSessionIds].map(id => [id, completionTimes.get(id) ?? 0]));
  completionReads = new Map([...completionReads].slice(-MAX_SESSION_COMPLETIONS));
  completionCachedRaw = JSON.stringify({
    unread: [...completionTimes].map(([id, at]) => [id, at, completionKeys.get(id)]),
    read: [...completionReads],
  });
  try { localStorage.setItem(SESSION_COMPLETION_STORAGE_KEY, completionCachedRaw); } catch {}
  for (const listener of completionListeners) listener();
}

/** Sidebar status markers read whether a successful final reply is waiting to be viewed. */
export function isSessionCompleted(sessionId: string): boolean {
  return readSessionCompletions().has(sessionId);
}

/** Sidebar status markers read boolean snapshots so unrelated sessions stay still. */
export function subscribeToSessionCompletion(listener: () => void): () => void {
  completionListeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === SESSION_COMPLETION_STORAGE_KEY || event.key === null) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { completionListeners.delete(listener);window.removeEventListener('storage', onStorage); };
}

/** The workspace acknowledges a final reply when its session is opened or the visible session finishes. */
export function markSessionCompletionRead(sessionId: string): void {
  if (!sessionId) return;
  readSessionCompletions();
  const eventKey = completionKeys.get(sessionId);
  completionReads.delete(sessionId);
  completionReads.set(sessionId, { at: Date.now(), ...(eventKey ? { eventKey } : {}) });
  completedSessionIds.delete(sessionId);completionTimes.delete(sessionId);
  publishSessionCompletions();
}

/** The running-sessions poll clears previous completions when the server confirms a new response. */
export function clearRunningSessionCompletions(sessionIds: readonly string[], observedAt = Infinity): void {
  readSessionCompletions();
  let changed = false;
  for (const id of sessionIds) {
    if ((completionTimes.get(id) ?? Infinity) < observedAt && completedSessionIds.delete(id)) {
      completionTimes.delete(id);completionOutput.delete(id);completionFailures.delete(id);changed = true;
    }
  }
  if (changed) publishSessionCompletions();
}

/** The workspace subscription records unseen final replies, acknowledging the visible session immediately. */
export function observeSessionCompletion(event: ServerEvent, viewedSessionId?: string | null): void {
  const id = event.sessionId;
  if (!id) return;
  readSessionCompletions();
  let changed = false;
  const clear = () => { if (completedSessionIds.delete(id)) { completionTimes.delete(id);changed = true; } };
  const output = (event.kind === 'text' || event.kind === 'stream_delta') && event.role !== 'user'
    && typeof event.content === 'string' && Boolean(event.content.trim());
  const activity = event.kind === 'status' && !['token_budget', 'codex_goal', 'context_compacted'].includes(String(event.text));
  if ((event.kind === 'text' && event.role === 'user') || activity
    || (event.kind === 'chat_subscribed' && event.isProcessing === true)) {
    if (completedSessionIds.has(id) || event.role === 'user') { completionOutput.delete(id);completionFailures.delete(id); }
    clear();
  }
  if (output) { clear();completionOutput.add(id);completionFailures.delete(id); }
  if (event.kind === 'error') { clear();completionFailures.add(id); }
  if (event.kind === 'complete') {
    const hasReply = completionOutput.has(id) || (typeof event.result === 'string' && Boolean(event.result.trim()));
    const success = event.success !== false && event.aborted !== true && (!completionFailures.has(id) || event.success === true);
    const eventKey = typeof event.id === 'string' ? `id:${event.id}`
      : typeof event.timestamp === 'string' ? `time:${event.timestamp}`
        : typeof event.seq === 'number' ? `seq:${event.seq}` : undefined;
    const receipt = completionReads.get(id);
    const eventTime = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    const alreadyRead = receipt && (eventKey && receipt.eventKey === eventKey
      || !receipt.eventKey && Number.isFinite(eventTime) && eventTime <= receipt.at);
    if (eventKey && success && hasReply) completionKeys.set(id, eventKey);
    if (viewedSessionId === id) markSessionCompletionRead(id);
    else if (alreadyRead) clear();
    else if (success && (hasReply || completedSessionIds.has(id))) {
      if (!completedSessionIds.has(id)) { completedSessionIds.add(id);completionTimes.set(id, Date.now());changed = true; }
    }
    else clear();
    completionOutput.delete(id);completionFailures.delete(id);
  }
  if (changed) publishSessionCompletions();
}
