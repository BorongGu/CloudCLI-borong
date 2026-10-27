import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = process.env.CLOUDCLI_PATCH_DIR || path.join(os.homedir(), '.config/cloudcli/backend-patch');
const files = [
  'server/modules/websocket/services/chat-session-writer.service.ts',
  'server/modules/websocket/services/chat-run-registry.service.ts',
  'server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts',
  'server/modules/user/user.routes.ts',
  'server/modules/user/user.service.ts',
  'server/modules/user/user.module.ts',
  'server/modules/database/repositories/session-drafts.db.ts',
  'server/shared/utils.ts',
  'server/shared/image-attachments.ts',
  'server/modules/providers/list/codex/codex-questions.provider.ts',
  'server/modules/providers/list/codex/codex-models.provider.ts',
  'server/modules/providers/services/codex-steering.service.ts',
  'server/modules/providers/list/codex/codex-shared-connection.ts',
  'server/modules/providers/list/codex/codex-shared-sdk.ts',
  'server/modules/providers/list/codex/codex-goals.provider.ts',
  'server/modules/providers/list/codex/codex-runtime.provider.ts',
  'server/modules/providers/list/codex/codex-sessions.provider.ts',
  'server/modules/providers/services/codex-goals.service.ts',
  'server/modules/providers/index.ts',
  'server/modules/providers/provider.routes.ts',
  'server/modules/websocket/services/chat-websocket.service.ts',
  'server/modules/websocket/services/btw-registry.service.ts',
  'server/modules/websocket/services/btw-websocket.service.ts',
  'server/modules/websocket/services/websocket-server.service.ts',
];

for (const file of files) {
  const filename = path.join(root, file);
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: filename, reportDiagnostics: true,
  });
  if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
    getCurrentDirectory: () => root, getNewLine: () => '\n', getCanonicalFileName: name => name,
  }));
  const js = result.outputText.replace(/(['"])@\/([^'"]+)\1/g, (_, quote, specifier) => {
    const relative = path.posix.relative(path.posix.dirname(file), 'server/' + specifier);
    return quote + (relative.startsWith('.') ? relative : './' + relative) + quote;
  });
  const target = path.join(output, 'tree', file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, js);
  console.log('Built ' + file);
}
