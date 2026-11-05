#!/usr/bin/env python3
"""Prepare a private guest runtime; persist generated credentials outside the repository."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket

repository = Path(__file__).resolve().parents[2]
root = Path(os.environ.get('GUEST_ROOT', Path.home() / '.local/share/cloudcli-guest'))
for directory in [root, root / 'config', root / 'data', root / 'data/codex', root / 'data/chat']:
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)

credentials_path = root / 'config/credentials.json'
if not credentials_path.exists():
    username = 'family'
    password = secrets.token_urlsafe(15)
    salt = secrets.token_hex(16)
    credentials = {'username': username, 'passwordSalt': salt,
                   'passwordHash': hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex(),
                   'sessionSecret': secrets.token_hex(32)}
    credentials_path.write_text(json.dumps(credentials))
    credentials_path.chmod(0o600)
    login = root / 'config/login.json'
    login.write_text(json.dumps({'username': username, 'password': password}))
    login.chmod(0o600)

# Only the subscription credential is copied; configuration and all histories are private to the guest runtime.
auth = root / 'data/codex/auth.json'
if not auth.exists():
    shutil.copyfile(Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'auth.json', auth)
    auth.chmod(0o600)
shutil.copyfile(repository / 'scripts/guest-chat/codex.toml', root / 'config/codex.toml')
(root / 'config/codex.toml').chmod(0o600)
gateways = {host: sorted({item[4][0] for item in socket.getaddrinfo(host, 443, socket.AF_INET)})
            for host in ['chatgpt.com', 'auth.openai.com', 'api.openai.com', 'ab.chatgpt.com']}
(root / 'config/egress.json').write_text(json.dumps(gateways))
(root / 'config/egress.json').chmod(0o600)
print('Private guest runtime prepared:', root)
