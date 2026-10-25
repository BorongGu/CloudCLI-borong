#!/usr/bin/env python3
"""Reapply this machine's browser defaults after a CloudCLI package update."""
from pathlib import Path
import hashlib
import json
import re
import shutil

dist = (Path.home() / '.local/share/cloudcli-runtime/node_modules/@cloudcli-ai/cloudcli/dist')
client_patch = (Path.home() / '.config/cloudcli/client-patch')
if (client_patch / 'index.html').exists():
    original_index = (Path.home() / '.config/cloudcli/client-original-index.html')
    if not original_index.exists():
        shutil.copy2(dist / 'index.html', original_index)
    # Publish hashed assets before switching the entry point. Existing browser
    # tabs can keep requesting the assets named by their loaded entry point.
    for entry in client_patch.iterdir():
        if entry.name == 'index.html':
            continue
        if entry.is_dir():
            shutil.copytree(entry, dist / entry.name, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, dist / entry.name)
    pending_index = dist / 'index.html.next'
    shutil.copy2(client_patch / 'index.html', pending_index)
    pending_index.replace(dist / 'index.html')
config = (Path.home() / '.codex/config.toml').read_text()
configured_model = re.search(r'^model\s*=\s*"([^"\n]+)"', config, re.MULTILINE)
if configured_model is None:
    raise RuntimeError('Codex default model is missing from config.toml')
model = configured_model.group(1)
bootstrap = '''try {
  const defaults = {
    'permissionMode-last-codex': 'bypassPermissions',
    'permissionMode-last-opencode': 'bypassPermissions',
    'selected-provider': 'codex',
    'userLanguage': 'zh-CN'
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
  const configuredModel = __CONFIGURED_MODEL__;
  if (localStorage.getItem('tailnet-codex-default-model') !== configuredModel) {
    localStorage.setItem('codex-model', configuredModel);
    localStorage.setItem('tailnet-codex-default-model', configuredModel);
  }
  const goDefault = 'opencode-go/glm-5.3-flash';
  if (localStorage.getItem('tailnet-opencode-go-default-model') !== goDefault) {
    localStorage.setItem('opencode-model', goDefault);
    localStorage.setItem('tailnet-opencode-go-default-model', goDefault);
  }
} catch {}
'''.replace('__CONFIGURED_MODEL__', json.dumps(model))
digest = hashlib.sha256(bootstrap.encode()).hexdigest()[:12]
asset_name = f'tailnet-defaults-{digest}.js'
(dist / asset_name).write_text(bootstrap)
index = dist / 'index.html'
html = index.read_text()
tag = f'<script src="/{asset_name}"></script>'
old_tag = r'<script src="/tailnet-defaults(?:-[a-f0-9]+)?\.js(?:\?[^"<>]*)?"></script>'
if re.search(old_tag, html):
    html = re.sub(old_tag, lambda _: tag, html)
else:
    html = html.replace('<head>', '<head>\n    ' + tag, 1)
index.write_text(html)

# Earlier bookmarks use /claude/. Route them into the same full application.
alias = dist.parent / 'public' / 'claude'
alias.mkdir(parents=True, exist_ok=True)
alias_index = alias / 'index.html'
pending_alias = alias / 'index.html.next'
pending_alias.write_text('''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=/">
<title>CloudCLI</title>
<script>location.replace('/' + location.search + location.hash);</script>
</head><body><a href="/">CloudCLI</a></body></html>
''')
pending_alias.replace(alias_index)

patches = (Path.home() / '.config/cloudcli/backend-patch')
backend = dist.parent / 'dist-server/server/modules/providers/list/codex'
if patches.exists():
    for patch in patches.glob('*.js'):
        target = backend / patch.name
        backup = target.with_suffix('.js.original')
        if target.exists() and not backup.exists():
            shutil.copy2(target, backup)
        shutil.copy2(patch, target)

# Publish patches for provider routes, native goals, and reconnect handling.
for patch in (patches / 'tree').rglob('*.js'):
    target = dist.parent / 'dist-server' / patch.relative_to(patches / 'tree')
    target.parent.mkdir(parents=True, exist_ok=True)
    backup = target.with_suffix('.js.original')
    if target.exists() and not backup.exists():
        shutil.copy2(target, backup)
    shutil.copy2(patch, target)

print(f'CloudCLI browser defaults applied: {model}, asset {asset_name}')
