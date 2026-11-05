import {
  expireAuthSession,
  getStoredAuthToken,
  storeAuthToken,
} from '@/shared/authToken';
import { IS_PLATFORM } from '@/shared/utils';
import { readVoiceConfig, voiceConfigHeaders } from '@/shared/voiceConfig';
import type { GuestChatBootstrap, GuestChatSnapshot, GuestChatSummary } from '@/shared/types';

async function guestRequest<T>(url: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 20000);
  try {
    const response = await fetch(url, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    const value = await response.json().catch(() => ({ error: '连接暂时中断，请重试。' }));
    if (!response.ok) throw Object.assign(new Error(value.error || '连接暂时中断，请重试。'), { status: response.status });
    if ('error' in value && !('id' in value) && !('authenticated' in value)) throw new Error(value.error);
    return value;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('连接等待较久，请重试；已保留发送内容。');
    throw error;
  } finally { clearTimeout(timer);signal?.removeEventListener('abort', abort); }
}

/** Guest chat uses cookie authentication and its separate, tightly scoped service. */
export const guestChatApi = {
  auth: (selected?: string | null, signal?: AbortSignal) => guestRequest<GuestChatBootstrap>('/api/auth' + (selected ? `?chat=${encodeURIComponent(selected)}` : ''), undefined, signal),
  login: (username: string, password: string) => guestRequest<GuestChatBootstrap>('/api/login', { username, password }),
  logout: () => guestRequest('/api/logout', {}),
  list: () => guestRequest<{ chats: GuestChatSummary[] }>('/api/chats'),
  create: () => guestRequest<GuestChatSnapshot>('/api/chats', {}),
  read: (id: string, signal?: AbortSignal) => guestRequest<GuestChatSnapshot>(`/api/chats/${encodeURIComponent(id)}`, undefined, signal),
  send: (id: string, text: string, images: string[], requestId: string, imageIds: string[] = []) => guestRequest<GuestChatSnapshot>(`/api/chats/${encodeURIComponent(id)}/messages`, { text, images, requestId, imageIds }),
  upload: (id: string, blob: Blob, onProgress: (percent: number) => void, signal: AbortSignal) => new Promise<{ id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', `/api/uploads/${encodeURIComponent(id)}`);xhr.timeout = 150000;xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => { done();
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300 || !result.id) reject(Object.assign(new Error(result.error || '图片上传失败，请重试。'), { status: xhr.status }));
        else { onProgress(100);resolve(result); }
      } catch { reject(new Error('图片上传确认失败，请重试。')); }
    };
    xhr.onerror = () => { done();reject(new Error('连接中断，点击图片重试上传。')); };
    xhr.ontimeout = () => { done();reject(new Error('图片上传等待较久，点击重试。')); };
    xhr.onabort = () => { done();reject(new DOMException('Upload cancelled', 'AbortError')); };
    if (signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError'));return; }
    signal.addEventListener('abort', abort, { once: true });xhr.send(blob);
  }),
  stop: (id: string) => guestRequest<GuestChatSnapshot>(`/api/chats/${encodeURIComponent(id)}/stop`, {}),
  image: (id: string) => `/api/images/${encodeURIComponent(id)}`,
  subscribe: (id: string, onSnapshot: (snapshot: GuestChatSnapshot) => void, onConnection: (connected: boolean) => void, initial?: GuestChatSnapshot) => {
    const url = new URL(`/api/live/${encodeURIComponent(id)}`, window.location.href);url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('delta', '1');if (initial) url.searchParams.set('revision', String(initial.revision));
    const socket = new WebSocket(url);let closed = false;
    let revision = initial?.revision;
    const messages = new Map(initial?.messages.map(message => [message.id, message]));
    let lastActivity = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastActivity > 50000) socket.close(); }, 10000);
    socket.onopen = () => { if (!closed) onConnection(true); };
    socket.onmessage = event => {
      lastActivity = Date.now();
      try {
        const snapshot = JSON.parse(event.data);
        if (closed || snapshot.id !== id) return;
        if (snapshot.type === 'patch') {
          if (snapshot.baseRevision !== revision) { socket.close();return; }
          snapshot.messages = snapshot.messages.map((patch: { id: string; textAppend?: string; reasoningAppend?: string }) => {
            const old = messages.get(patch.id);const { textAppend, reasoningAppend, ...fields } = patch;
            return { ...old, ...fields, ...(textAppend === undefined ? {} : { text: (old?.text || '') + textAppend }), ...(reasoningAppend === undefined ? {} : { reasoning: (old?.reasoning || '') + reasoningAppend }) };
          });
        }
        if (!snapshot.partial) messages.clear();
        for (const message of snapshot.messages) messages.set(message.id, message);
        revision = snapshot.revision;onSnapshot(snapshot);
      } catch { socket.close(); }
    };
    socket.onclose = () => { clearInterval(watchdog);if (!closed) onConnection(false); };
    socket.onerror = () => socket.close();
    return () => { closed = true;clearInterval(watchdog);socket.close(); };
  },
};

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    // Every response here can carry X-Refreshed-Token or X-Auth-Error, and a
    // served-from-cache response replays the headers it was stored with. Those
    // headers describe one moment in one session, so they must never be reused:
    // a stale X-Refreshed-Token overwrote the current token with an expired one
    // on every start, which then got discarded as expired.
    cache: 'no-store',
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      storeAuthToken(refreshedToken);
    }
    // Belt and braces for any path that still reaches a cached response: only a
    // real rejection ends the session. Note that a revalidated response surfaces
    // its stored status (typically 200), not the 304 from the wire, so the
    // header alone says nothing about the current request.
    if (response.status === 401 && response.headers.get('X-Auth-Error')) {
      expireAuthSession();
    }
    return response;
  });
};

type AssetUploadOptions = { onProgress: (percent: number) => void; signal: AbortSignal; requestId: string };
function uploadAssetForm(form: FormData, options: AssetUploadOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();const abort = () => xhr.abort();const cleanup = () => options.signal.removeEventListener('abort', abort);
    xhr.open('POST', '/api/assets/files');xhr.timeout = 150000;xhr.withCredentials = true;
    const token = getStoredAuthToken();if (!IS_PLATFORM && token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('X-Upload-Id', options.requestId);
    xhr.upload.onprogress = event => { if (event.lengthComputable) options.onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      cleanup();const refreshed = xhr.getResponseHeader('X-Refreshed-Token');if (refreshed) storeAuthToken(refreshed);
      if (xhr.status === 401 && xhr.getResponseHeader('X-Auth-Error')) expireAuthSession();
      if (!xhr.status) { reject(new Error('上传连接已中断，请重试。'));return; }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers: { 'Content-Type': 'application/json' } }));
    };
    xhr.onerror = () => { cleanup();reject(new Error('上传连接中断，点击重试。')); };
    xhr.ontimeout = () => { cleanup();reject(new Error('上传超时，文件已保留，请重试。')); };
    xhr.onabort = () => { cleanup();reject(new DOMException('Upload cancelled', 'AbortError')); };
    if (options.signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError'));return; }
    options.signal.addEventListener('abort', abort, { once: true });xhr.send(form);
  });
}

// Cache image bytes, not authenticated HTTP responses: refreshed-token headers must remain fresh.
const chatImageBytes = new Map<string, { blob: Blob; until: number }>();
function rememberChatImage(filename: string, blob: Blob, token = getStoredAuthToken()) {
  if (IS_PLATFORM || !token || blob.size > 10 * 1024 * 1024) return;
  const key = `${token}:${filename}`;chatImageBytes.delete(key);chatImageBytes.set(key, { blob, until: Date.now() + 600000 });
  let size = [...chatImageBytes.values()].reduce((sum, value) => sum + value.blob.size, 0);
  while (chatImageBytes.size > 24 || size > 32 * 1024 * 1024) {
    const [oldest, entry] = chatImageBytes.entries().next().value!;size -= entry.blob.size;chatImageBytes.delete(oldest);
  }
}
async function readChatImage(filename: string, options: ApiRequestOptions = {}): Promise<Response> {
  const token = getStoredAuthToken();const key = `${token}:${filename}`;
  if (options.signal?.aborted) throw new DOMException('Image request cancelled', 'AbortError');
  const saved = !IS_PLATFORM && token ? chatImageBytes.get(key) : undefined;
  if (saved && saved.until > Date.now()) return new Response(saved.blob, { headers: { 'Content-Type': saved.blob.type } });
  chatImageBytes.delete(key);
  const response = await authenticatedFetch(`/api/assets/images/${encodeURIComponent(filename)}`, options);
  if (!response.ok) return response;
  const blob = await response.blob();rememberChatImage(filename, blob, token);
  return new Response(blob, { status: response.status, headers: { 'Content-Type': blob.type } });
}

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}

/**
 * Picks the server's human-readable message out of a failed response body, or
 * null when it carries none. Accepts the legacy string envelope
 * (`error: 'message'`), the structured AppError envelope
 * (`error: { code, message, details }`) and a top-level `message`.
 *
 * The non-throwing counterpart of readApiJson, used by the auth and onboarding
 * screens because they show their own localized message when the server gives
 * none, by the plugins context for failed plugin list, install, update,
 * uninstall and toggle calls, which all answer with the structured envelope,
 * and by the chat drafts store to say why the server refused a queued message.
 */
export function readApiErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const { error, message } = body as { error?: unknown; message?: unknown };
  const candidates = [
    error && typeof error === 'object' ? (error as { message?: unknown }).message : error,
    message,
  ];
  // The body is unchecked JSON: anything but a non-blank string is skipped, as
  // an object rendered as a React child throws and unmounts the screen.
  const readable = candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  );
  return readable ?? null;
}

const get = (url: string, options: ApiRequestOptions = {}) => authenticatedFetch(url, options);

const withBody =
  (method: string) =>
    (url: string, body?: unknown, options: ApiRequestOptions = {}) =>
      authenticatedFetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });

const post = withBody('POST');
const put = withBody('PUT');
const patch = withBody('PATCH');
const del = withBody('DELETE');

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session. Omitting `limit` requests the whole
 * transcript; passing one always pairs it with an explicit offset so automatic
 * refreshes can never accidentally become an unbounded transcript request.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0 }: { limit?: number | null; offset?: number } = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Every `/api/...` path the frontend talks to is declared here; components
// import a named method instead of assembling URLs of their own.

export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username: string, password: string) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username: string, password: string) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => post('/api/auth/refresh'),
    user: () => get('/api/auth/user'),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => get('/api/projects'),
  archivedProjects: () => get('/api/projects/archived'),
  projectSessions: (
    projectId: string,
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
    options: ApiRequestOptions = {},
  ) =>
    get(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query({ limit, offset })}`,
      options,
    ),
  projectTaskmaster: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  renameProject: (projectId: string, displayName: string) =>
    put(`/api/projects/${projectId}/rename`, { displayName }),
  restoreProject: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/restore`),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId: string, hardDelete = false) =>
    del(`/api/projects/${projectId}${query({ force: hardDelete })}`),
  createProject: (projectData: unknown) => post('/api/projects/create-project', projectData),
  migrateLegacyProjectStars: (projectIds: string[]) =>
    post('/api/projects/migrate-legacy-stars', { projectIds }),
  toggleProjectStar: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`),
  // A clone is two requests: the details (GitHub token included) go in this
  // POST body, and the returned `cloneId` is all the progress stream's URL
  // carries — URLs land in access logs, proxy logs and browser history.
  startProjectClone: (cloneRequest: {
    path: string;
    githubUrl: string;
    githubTokenId: number | null;
    newGithubToken: string | null;
  }) => post('/api/projects/clone', cloneRequest),
  // EventSource cannot send an Authorization header, so the token rides along as
  // a query parameter on the streaming endpoints below.
  cloneProjectProgressUrl: ({ cloneId }: { cloneId: string }) =>
    `/api/projects/clone-progress${query({ cloneId, token: getStoredAuthToken() })}`,
  searchConversationsUrl: (searchQuery: string, limit = 50) =>
    `/api/providers/search/sessions${query({
      q: searchQuery,
      limit,
      token: getStoredAuthToken(),
    })}`,

  // Session endpoints. Provider/project metadata are resolved by the backend
  // from the session id.
  // Session deletion mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId: string, hardDelete = false) =>
    del(`/api/providers/sessions/${sessionId}${query({ force: hardDelete })}`),
  getArchivedSessions: () => get('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () => get('/api/providers/sessions/running'),
  recentConversations: ({ limit = 40, offset = 0 }: { limit?: number; offset?: number } = {}) =>
    get(`/api/providers/sessions/recent${query({ limit, offset })}`),
  providerSessionId: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId: string) => post(`/api/providers/sessions/${sessionId}/restore`),
  // Creates an independent session holding this one's conversation up to
  // `upToAnchorId` (all of it when omitted). The source is left untouched.
  forkSession: (sessionId: string, body: { upToAnchorId?: string; title?: string } = {}) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/fork`, body),
  // The dedicated socket closes with its window, which releases the ephemeral fork.
  btwSocketUrl: () => `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/btw${query({
    token: IS_PLATFORM ? undefined : getStoredAuthToken(),
  })}`,
  renameSession: (sessionId: string, summary: string) =>
    put(`/api/providers/sessions/${sessionId}`, { summary }),
  // What one agent of a workflow run did, read from its transcript on demand
  // when its row in the workflow card is opened.
  workflowAgentActivity: (sessionId: string, runId: string, agentId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}`),

  // Scheduled messages: send a message to a session at a future time.
  scheduledMessages: {
    list: (sessionId?: string) =>
      get(`/api/scheduled-messages${sessionId ? query({ sessionId }) : ''}`),
    create: (body: { sessionId: string; content: string; scheduledFor: string; options?: unknown }) =>
      post('/api/scheduled-messages', body),
    cancel: (id: string) => del(`/api/scheduled-messages/${encodeURIComponent(id)}`),
  },

  // Workspace file tree
  readFile: (projectId: string, filePath: string) =>
    get(`/api/file-tree/projects/${projectId}/file${query({ filePath })}`),
  // Raw bytes for a workspace file. The endpoint requires the auth header, so
  // media call sites fetch a blob through here instead of using a bare `src`.
  readFileBlob: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(fileContentPath(projectId, filePath), options),
  saveFile: (projectId: string, filePath: string, content: string) =>
    put(`/api/file-tree/projects/${projectId}/file`, { filePath, content }),
  getFiles: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/files${query({ respectGitignore: true })}`, options),

  // File operations
  createFile: (
    projectId: string,
    { path, type, name }: { path: string; type: string; name: string },
  ) => post(`/api/file-tree/projects/${projectId}/files/create`, { path, type, name }),

  renameFile: (projectId: string, { oldPath, newName }: { oldPath: string; newName: string }) =>
    put(`/api/file-tree/projects/${projectId}/files/rename`, { oldPath, newName }),

  deleteFile: (projectId: string, { path, type }: { path: string; type: string }) =>
    del(`/api/file-tree/projects/${projectId}/files`, { path, type }),

  // Uploads with a progress bar go through XMLHttpRequest, which needs the URL.
  uploadFilesUrl: (projectId: string) =>
    `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/upload`,

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath: string | null = null) =>
    get(`/api/file-tree/browse-filesystem${query({ path: dirPath })}`),

  createFolder: (folderPath: string) => post('/api/file-tree/create-folder', { path: folderPath }),

  // Git endpoints. The `project` param carries the DB projectId post-migration.
  git: {
    status: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/status${query({ project: projectId })}`, options),
    diff: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/diff${query({ project: projectId, file: filePath })}`, options),
    commitDiff: (projectId: string, commit: string) =>
      get(`/api/git/commit-diff${query({ project: projectId, commit })}`),
    fileWithDiff: (projectId: string, filePath: string) =>
      get(`/api/git/file-with-diff${query({ project: projectId, file: filePath })}`),
    branches: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branches${query({ project: projectId })}`, options),
    branchDiff: (projectId: string, base: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branch-diff${query({ project: projectId, base })}`, options),
    // `oldPath` is the pre-rename path of a renamed file so the server can diff the rename itself.
    branchDiffFile: (
      projectId: string,
      base: string,
      filePath: string,
      oldPath?: string,
      options: ApiRequestOptions = {},
    ) => get(`/api/git/branch-diff/file${query({ project: projectId, base, file: filePath, oldPath })}`, options),
    remoteStatus: (projectId: string) =>
      get(`/api/git/remote-status${query({ project: projectId })}`),
    commits: (
      projectId: string,
      { limit }: { limit?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(`/api/git/commits${query({ project: projectId, limit })}`, options),
    checkout: (projectId: string, branch: string) =>
      post('/api/git/checkout', { project: projectId, branch }),
    createBranch: (projectId: string, branch: string) =>
      post('/api/git/create-branch', { project: projectId, branch }),
    deleteBranch: (projectId: string, branch: string, force = false) =>
      post('/api/git/delete-branch', { project: projectId, branch, force }),
    fetch: (projectId: string) => post('/api/git/fetch', { project: projectId }),
    pull: (projectId: string) => post('/api/git/pull', { project: projectId }),
    push: (projectId: string) => post('/api/git/push', { project: projectId }),
    publish: (projectId: string, branch: string) =>
      post('/api/git/publish', { project: projectId, branch }),
    discard: (projectId: string, file: string) =>
      post('/api/git/discard', { project: projectId, file }),
    deleteUntracked: (projectId: string, file: string) =>
      post('/api/git/delete-untracked', { project: projectId, file }),
    stage: (projectId: string, files: string[]) =>
      post('/api/git/stage', { project: projectId, files }),
    unstage: (projectId: string, files: string[]) =>
      post('/api/git/unstage', { project: projectId, files }),
    commit: (projectId: string, message: string, files: string[]) =>
      post('/api/git/commit', { project: projectId, message, files }),
    initialCommit: (projectId: string) => post('/api/git/initial-commit', { project: projectId }),
    init: (projectId: string) => post('/api/git/init', { project: projectId }),
    revertLocalCommit: (projectId: string) =>
      post('/api/git/revert-local-commit', { project: projectId }),
    generateCommitMessage: (projectId: string, files: string[], provider: string) =>
      post('/api/git/generate-commit-message', { project: projectId, files, provider }),
  },

  worktrees: {
    list: (projectId: string) => get(`/api/worktrees${query({ project: projectId })}`),
    create: (
      projectId: string,
      { branch, baseBranch }: { branch: string; baseBranch: string | null },
    ) => post('/api/worktrees/create', { project: projectId, branch, baseBranch }),
    open: (projectId: string, worktreePath: string) =>
      post('/api/worktrees/open', { project: projectId, worktreePath }),
    merge: (
      projectId: string,
      worktreePath: string,
      options: { squash?: boolean; message?: string; removeAfterMerge?: boolean },
    ) => post('/api/worktrees/merge', { project: projectId, worktreePath, ...options }),
    remove: (
      projectId: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ) => post('/api/worktrees/remove', { project: projectId, worktreePath, ...options }),
  },

  // Provider (coding agent) endpoints — models, capabilities, sessions, MCP, skills.
  providers: {
    capabilities: () => get('/api/providers/capabilities'),
    authStatus: (provider: string) =>
      get(`/api/providers/${encodeURIComponent(provider)}/auth/status`),
    claudeSettingsPermissions: () => get('/api/providers/claude/settings-permissions'),

    models: (provider: string) => get(`/api/providers/${provider}/models`),
    createModel: (provider: string, input: unknown) =>
      post(`/api/providers/${provider}/models`, input),
    updateModel: (provider: string, recordId: string | number, input: unknown) =>
      patch(`/api/providers/${provider}/models/${recordId}`, input),
    deleteModel: (provider: string, recordId: string | number) =>
      del(`/api/providers/${provider}/models/${recordId}`),
    setCustomModelsOnly: (provider: string, enabled: boolean) =>
      put(`/api/providers/${provider}/models/custom-only`, { enabled }),

    createSession: (payload: {
      provider: string;
      projectPath: string;
      initialMessage?: unknown;
    }) => post('/api/providers/sessions', payload),
    sessionMessages: (
      sessionId: string,
      pagination: { limit?: number | null; offset?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(sessionMessagesUrl(sessionId, pagination), options),
    usage: (params: { sessionId?: string; provider: string; model?: string; refresh?: number }, options: ApiRequestOptions = {}) =>
      get(`/api/providers/usage${query(params)}`, options),
    sessionTokenUsage: (sessionId: string) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/token-usage`),
    steerSession: (sessionId: string, content: string, attachments: unknown[]) =>
      post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/steer`, { content, attachments }),
    sessionGoal: (sessionId: string, options: ApiRequestOptions = {}) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/goal`, options),
    setSessionGoal: (sessionId: string, action: 'pause' | 'resume' | 'clear' | 'set', objective?: string) =>
      post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/goal`, { action, objective }),
    sessionActiveModel: (provider: string, sessionId: string) =>
      get(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`),
    setSessionActiveModel: (provider: string, sessionId: string, model: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
      }),
    setSessionActiveEffort: (provider: string, sessionId: string, effort: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-effort`, {
        effort,
      }),

    mcpServers: (
      provider: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) => get(`/api/providers/${provider}/mcp/servers${query({ scope, workspacePath })}`),
    saveMcpServer: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/mcp/servers`, payload),
    deleteMcpServer: (
      provider: string,
      serverName: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) =>
      del(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(serverName)}${query({ scope, workspacePath })}`,
      ),
    saveGlobalMcpServer: (payload: unknown) => post('/api/providers/mcp/servers/global', payload),

    skills: (provider: string, { workspacePath }: { workspacePath?: string } = {}) =>
      get(`/api/providers/${encodeURIComponent(provider)}/skills${query({ workspacePath })}`),
    saveSkills: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/skills`, payload),
  },

  // Slash commands
  commands: {
    // `projectPath` stays optional: a workspace without a resolved path omits
    // the field entirely, which is what the server expects.
    list: (projectPath: string | undefined) => post('/api/commands/list', { projectPath }),
    execute: (payload: unknown) => post('/api/commands/execute', payload),
  },

  // Chat attachments, stored globally under ~/.cloudcli/assets
  assets: {
    uploadFiles: (formData: FormData, options?: AssetUploadOptions) => options ? uploadAssetForm(formData, options) :
      authenticatedFetch('/api/assets/files', {
        method: 'POST',
        headers: {}, // Let browser set Content-Type for FormData
        body: formData,
      }),
    file: (storedName: string) => get(`/api/assets/files/${encodeURIComponent(storedName)}`),
    image: readChatImage,
    cacheImage: rememberChatImage,
  },

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Update a task
    updateTask: (projectId: string, taskId: string | number, updates: unknown) =>
      put(`/api/taskmaster/update-task/${projectId}/${taskId}`, updates),

    tasks: (projectId: string) => get(`/api/taskmaster/tasks/${encodeURIComponent(projectId)}`),
    mcpStatus: () => get('/api/taskmaster/mcp-status'),
    installationStatus: () => get('/api/taskmaster/installation-status'),

    prdFiles: (projectId: string) => get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`),
    prdFile: (projectId: string, fileName: string) =>
      get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`),
    savePrd: (projectId: string, { fileName, content }: { fileName: string; content: string }) =>
      post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, { fileName, content }),
  },

  // User endpoints
  user: {
    sessionPins: () => get('/api/user/session-pins'),
    setSessionPin: (sessionId: string, pinned: boolean) => put('/api/user/session-pins', { sessionId, pinned }),
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status'),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    // Without `queuedMessage` only the text is written; the stored queued
    // message is left as it is.
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown }) =>
      put('/api/user/drafts', { scope, ...draft }),
    // Appends to the scope's queued message on the server and returns the
    // message that is now queued.
    appendQueuedMessage: (scope: string, queuedMessage: unknown) =>
      post('/api/user/drafts/queued-message', { scope, queuedMessage }),
    clearQueuedMessage: (scope: string) => del('/api/user/drafts/queued-message', { scope }),
  },

  // Server-side settings: API keys, stored credentials, notifications, web push
  settings: {
    apiKeys: () => get('/api/settings/api-keys'),
    createApiKey: (keyName: string) => post('/api/settings/api-keys', { keyName }),
    deleteApiKey: (keyId: string) => del(`/api/settings/api-keys/${keyId}`),
    toggleApiKey: (keyId: string, isActive: boolean) =>
      patch(`/api/settings/api-keys/${keyId}/toggle`, { isActive }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      subscribe: (subscription: { endpoint?: string; keys?: unknown }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  voice: {
    health: () => get('/api/voice/health'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
  },

  system: {
    health: (options: ApiRequestOptions = {}) => get('/health', options),
  },
};

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the CloudCLI proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the CloudCLI voice proxy.
 */
export function transcribeVoice(blob: Blob, filename: string): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body,
    });
  }

  body.append('audio', blob, filename);
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the CloudCLI voice proxy.
 */
export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}
