import { mkdir, copyFile, cp, rename, readdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const output = path.join(process.env.GUEST_ROOT || path.join(os.homedir(), '.local/share/cloudcli-guest'), 'build');
await mkdir(output, { recursive: true, mode: 0o700 });
await build({ entryPoints: [path.join(repository, 'server/guest.ts'), path.join(repository, 'server/guest-egress.ts')],
  outdir: output, bundle: true, platform: 'node', target: 'node22', format: 'esm', outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __makeRequire } from 'node:module'; const require = __makeRequire(import.meta.url);" },
  tsconfig: path.join(repository, 'server/tsconfig.json'),
});
await cp(path.join(repository, 'dist-guest'), path.join(output, 'public'), { recursive: true });
await rename(path.join(output, 'public/guest.html'), path.join(output, 'public/index.html'));
for (const filename of ['index.html', ...(await readdir(path.join(output, 'public/assets'))).filter(name => /\.(js|css)$/.test(name)).map(name => `assets/${name}`)]) {
  const target = path.join(output, 'public', filename);const bytes = await readFile(target);
  await writeFile(target + '.br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
  await writeFile(target + '.gz', gzipSync(bytes));
}
for (const filename of ['Dockerfile', 'entrypoint.sh']) await copyFile(path.join(repository, 'scripts/guest-chat', filename), path.join(output, filename));
await copyFile('/etc/ssl/certs/ca-certificates.crt', path.join(output, 'ca-certificates.crt'));
await copyFile(process.execPath, path.join(output, 'node'));
if (!process.env.GUEST_CODEX_SOURCE) throw new Error('Set GUEST_CODEX_SOURCE to the installed native Codex binary.');
await copyFile(process.env.GUEST_CODEX_SOURCE, path.join(output, 'codex'));
console.log('Guest build prepared:', output);
