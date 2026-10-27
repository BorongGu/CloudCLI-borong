#!/usr/bin/env python3
"""Choose the bind address before starting this host's CloudCLI user service."""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


SERVICE = 'codex-web.service'
MODES = ('localhost', 'tailnet')


class StartupError(Exception):
    """A startup failure suitable for display without private environment data."""


def setting(text, name, default=''):
    values = re.findall(r'^\s*' + re.escape(name) + r'\s*=([^\n]*)$', text, re.MULTILINE)
    if not values:
        return default
    words = shlex.split(values[-1], comments=True)
    return words[0] if words else default


def current_mode(text):
    host = setting(text, 'HOST')
    return 'localhost' if host in ('localhost', '127.0.0.1', '::1', '[::1]') else 'tailnet'


def choose_mode(current):
    if not sys.stdin.isatty():
        raise StartupError('请指定启动模式：cloudcli-start localhost 或 cloudcli-start tailnet')
    print('CloudCLI 启动模式：')
    print('  1. localhost · 仅运行服务的电脑访问')
    print('  2. Tailnet   · 公司 Tailnet 中的设备访问')
    default = '1' if current == 'localhost' else '2'
    answer = input(f'请选择 [{default}]：').strip().lower() or default
    selected = {'1': 'localhost', '2': 'tailnet', 'localhost': 'localhost', 'tailnet': 'tailnet'}.get(answer)
    if selected is None:
        raise StartupError('启动模式应为 1（localhost）或 2（Tailnet）')
    return selected


def tailnet_host():
    try:
        result = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        raise StartupError('读取 Tailnet 地址失败；请先检查 tailscale 连接。') from None
    for candidate in result.stdout.split():
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address in ipaddress.ip_network('100.64.0.0/10'):
            return str(address)
    raise StartupError('tailscale 返回的地址中缺少 Tailnet IPv4 地址。')


def with_host(text, host):
    # Preserve credentials, comments and other settings byte-for-byte.
    lines = text.splitlines(keepends=True)
    result = []
    replaced = False
    for line in lines:
        if re.match(r'^\s*HOST\s*=', line):
            if not replaced:
                result.append(f'HOST={host}\n')
                replaced = True
        elif not re.match(r'^\s*CLOUDCLI_LISTEN_LOCALHOST\s*=', line):
            result.append(line)
    content = ''.join(result)
    if not replaced:
        content += ('' if not content or content.endswith('\n') else '\n') + f'HOST={host}\n'
    return content


def write_environment(filename, text):
    # Replace atomically so systemd always reads a complete private file.
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=filename.parent, prefix='.server-env-', delete=False) as file:
            pending = Path(file.name)
            os.fchmod(file.fileno(), 0o600)
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        pending.replace(filename)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def restart_service():
    try:
        subprocess.run(['systemctl', '--user', 'restart', SERVICE], capture_output=True, text=True, timeout=45, check=True)
    except (OSError, subprocess.SubprocessError):
        raise StartupError('systemctl 启动 CloudCLI 失败。') from None


def wait_ready(host, port, timeout=20):
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            with opener.open(f'http://{host}:{port}/health', timeout=1) as response:
                body = json.load(response)
                if isinstance(body, dict) and body.get('status') == 'ok':
                    return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    raise StartupError('等待 CloudCLI 健康检查超时。')


def start(mode, filename):
    if mode not in MODES:
        raise StartupError('启动模式应为 localhost 或 tailnet')
    filename = filename.expanduser().resolve(strict=True)
    original = filename.read_text(encoding='utf-8')
    host = '127.0.0.1' if mode == 'localhost' else tailnet_host()
    try:
        port = int(setting(original, 'SERVER_PORT', '3001'))
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise StartupError('SERVER_PORT 应为 1 到 65535 之间的端口。') from None
    write_environment(filename, with_host(original, host))
    try:
        restart_service()
        wait_ready(host, port)
    except StartupError:
        write_environment(filename, original)
        try:
            restart_service()
            wait_ready(setting(original, 'HOST', '127.0.0.1'), port)
        except StartupError:
            raise StartupError('启动失败，原配置已恢复；请通过 systemctl --user status codex-web.service 检查服务。') from None
        raise StartupError('启动失败，已恢复原配置并重新启动服务。') from None
    return f'http://{"localhost" if mode == "localhost" else host}:{port}'


def main(argv=None):
    parser = argparse.ArgumentParser(description='启动 CloudCLI，并选择 localhost 或 Tailnet 模式。')
    parser.add_argument('mode', nargs='?', choices=MODES)
    parser.add_argument('--mode', dest='selected_mode', choices=MODES)
    parser.add_argument('--status', action='store_true', help='显示已保存的启动模式和访问地址')
    args = parser.parse_args(argv)
    if args.mode and args.selected_mode and args.mode != args.selected_mode:
        parser.error('两个启动模式参数冲突')
    filename = Path.home() / '.config/cloudcli/server.env'
    try:
        text = filename.read_text(encoding='utf-8')
        if args.status:
            host = setting(text, 'HOST')
            print(f'已保存模式：{current_mode(text)}')
            print(f'访问地址：http://{"localhost" if current_mode(text) == "localhost" else host}:{setting(text, "SERVER_PORT", "3001")}')
            return 0
        mode = args.selected_mode or args.mode or choose_mode(current_mode(text))
        url = start(mode, filename)
        print(f'CloudCLI 已启动 · {mode}')
        print(f'访问地址：{url}')
        print('后续启动及开机自启动将沿用此模式。')
        return 0
    except (StartupError, OSError, EOFError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, StartupError) else '请检查服务环境文件和当前用户的服务权限。'
        print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
