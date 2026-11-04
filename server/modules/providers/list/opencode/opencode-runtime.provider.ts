import fsSync from 'node:fs';

import crossSpawn from 'cross-spawn';
import type Database from 'better-sqlite3';

import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderModelsDefinition } from '@/shared/types.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell, getOpenCodeDatabasePath, getOpenCodeMajorVersion, openOpenCodeReadDatabase, stripAnsiSequences } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

type OpenCodeProcess = ReturnType<typeof crossSpawn> & { sessionId?: string; aborted?: boolean };
const activeOpenCodeProcesses = new Map<string, OpenCodeProcess>();

/** Provider runtime and its regression tests map UI permissions to the installed CLI generation.
 * Plan selects the native plan agent; unrestricted selects --auto. Edit mode augments
 * V1's permission environment or V2's ruleset while retaining the surrounding config.
 */
export function resolveOpenCodePermissionOptions(permissionMode: string | undefined, major = 1): { args: string[]; env: NodeJS.ProcessEnv } {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      if (major >= 2) {
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
        return { args: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permissions: [...(config.permissions || []), { action: 'edit', resource: '*', effect: 'allow' }] }) } };
      }
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(model: string | undefined, effort: string | undefined, modelsDefinition: ProviderModelsDefinition | null) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readOpenCodeSessionId(event: AnyRecord) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

function readOpenCodeTokenUsage(sessionId: string | null) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = openOpenCodeReadDatabase(dbPath);
    const columns = db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId) as AnyRecord | undefined;

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Provider runtime service starts an owned CLI run and normalizes its lifecycle and output. */
async function spawnOpenCode(command: string, options: AnyRecord, ws: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
  return new Promise<void>((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      model,
      effort,
      sessionSummary,
      images,
      files,
      permissionMode
    } = options;
    // Callers pass the stable app session id; the CLI resumes with the
    // provider-native id recorded on the session row.
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess: OpenCodeProcess | null = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;

    const notifyTerminalState = ({ code = null, error = null }: { code?: number | null; error?: unknown } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId: string | null) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        activeOpenCodeProcesses.set(capturedSessionId, opencodeProcess);
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line: string) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        const normalized = context.normalizeMessage(response, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      let effortModels: ProviderModelsDefinition | null = null;
      try {
        effortModels = await context.getProviderModels();
      } catch (error) {
        console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
      }

      const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);
      const major = getOpenCodeMajorVersion();
      const args = ['run', '--format', 'json'];
      if (major >= 2) args.push('--standalone');
      // V1 requires --dir; V2 resolves the workspace from cwd and PWD.
      if (major < 2) args.push('--dir', workingDir);
      if (providerSessionId) {
        args.push('--session', providerSessionId);
      }
      if (resolvedModel) {
        args.push('--model', major >= 2 && resolvedEffort ? `${resolvedModel}#${resolvedEffort}` : resolvedModel);
      }
      if (resolvedEffort && major < 2) {
        args.push('--variant', resolvedEffort);
      }
      const permissionOptions = resolveOpenCodePermissionOptions(permissionMode, major);
      args.push(...permissionOptions.args);
      const hasAttachments =
        normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      if ((command && command.trim()) || hasAttachments) {
        // Image attachments ride along as an <images_input> path list appended
        // to the prompt; the session history reader strips the tag back out.
        // opencode is a .cmd shim on Windows, so the whole argument must be
        // newline-free or cmd.exe silently truncates it at the first newline.
        const promptWithAttachments = appendFilesInputTag(
          appendImagesInputTag(command?.trim() || '', images),
          files
        );
        args.push(flattenPromptForWindowsShell(promptWithAttachments));
      }

      opencodeProcess = spawnFunction('opencode', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PWD: workingDir, ...permissionOptions.env },
      });

      activeOpenCodeProcesses.set(processKey, opencodeProcess);
      opencodeProcess.sessionId = processKey;
      opencodeProcess.stdin?.end();

      opencodeProcess.stdout?.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processOpenCodeOutputLine(line.trim());
        });
      });

      opencodeProcess.stderr?.on('data', (data) => {
        // opencode styles its stderr for a terminal; the chat renders plain
        // text, so the escapes have to go before the text is surfaced. A chunk
        // that was styling only cleans down to nothing and is not an error.
        const stderrText = stripAnsiSequences(data.toString());
        if (!stderrText.trim()) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      });

      opencodeProcess.on('close', async (code) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        if (stdoutLineBuffer.trim()) {
          processOpenCodeOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        // OpenCode's own database is keyed by the provider-native id.
        const tokenBudget = readOpenCodeTokenUsage(capturedSessionId);
        if (tokenBudget) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        // Terminal complete — skipped for aborted runs (abort-session
        // already sent the aborted complete on this run's behalf).
        if (!completeSent && !opencodeProcess?.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: code }));
        }

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await context.isProviderInstalled();
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
              sessionId: finalSessionId,
              provider: 'opencode',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`));
      });

      opencodeProcess.on('error', async (error) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));
        if (!completeSent && !opencodeProcess?.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

/** Provider runtime aborts the child associated with the app session ID. */
function abortOpenCodeSession(sessionId: string) {
  const process = activeOpenCodeProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  process.aborted = true;
  process.kill('SIGTERM');
  activeOpenCodeProcesses.delete(sessionId);
  return true;
}

/** Provider activity service reads process ownership for running indicators. */
export function isOpenCodeSessionActive(sessionId: string) {
  return activeOpenCodeProcesses.has(sessionId);
}

/** OpenCode provider module exposes the run/abort contract to the shared runtime service. */
export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
};
