import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('cloudcli_start', Path(__file__).resolve().parents[1] / 'cloudcli-start.py')
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class StartupModesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.filename = Path(self.directory.name) / 'server.env'
        self.original = '# Private service settings\nHOST=100.64.0.46\nSERVER_PORT=3001\nPRIVATE_VALUE="test secret"\n'
        self.filename.write_text(self.original)

    def test_localhost_starts_on_loopback_without_tailscale_and_preserves_other_settings(self):
        with patch.object(launcher, 'tailnet_host') as tailscale, patch.object(launcher, 'restart_service') as restart, patch.object(launcher, 'wait_ready') as ready:
            url = launcher.start('localhost', self.filename)
        self.assertEqual(url, 'http://localhost:3001')
        self.assertEqual(self.filename.read_text(), self.original.replace('100.64.0.46', '127.0.0.1'))
        self.assertEqual(os.stat(self.filename).st_mode & 0o777, 0o600)
        tailscale.assert_not_called()
        restart.assert_called_once()
        ready.assert_called_once_with('127.0.0.1', 3001)

    def test_tailnet_resolves_the_current_device_address_each_time(self):
        with patch.object(launcher, 'tailnet_host', return_value='100.100.10.20'), patch.object(launcher, 'restart_service'), patch.object(launcher, 'wait_ready') as ready:
            url = launcher.start('tailnet', self.filename)
        self.assertEqual(url, 'http://100.100.10.20:3001')
        self.assertEqual(launcher.setting(self.filename.read_text(), 'HOST'), '100.100.10.20')
        ready.assert_called_once_with('100.100.10.20', 3001)

    def test_failed_tailnet_detection_keeps_the_existing_service_and_configuration(self):
        with patch.object(launcher, 'tailnet_host', side_effect=launcher.StartupError('offline')), patch.object(launcher, 'restart_service') as restart:
            with self.assertRaises(launcher.StartupError):
                launcher.start('tailnet', self.filename)
        self.assertEqual(self.filename.read_text(), self.original)
        restart.assert_not_called()

    def test_failed_health_check_restores_the_previous_configuration_and_restarts_it(self):
        with patch.object(launcher, 'restart_service') as restart, patch.object(launcher, 'wait_ready', side_effect=[launcher.StartupError('timeout'), None]) as ready:
            with self.assertRaisesRegex(launcher.StartupError, '恢复原配置'):
                launcher.start('localhost', self.filename)
        self.assertEqual(self.filename.read_text(), self.original)
        self.assertEqual(restart.call_count, 2)
        self.assertEqual(ready.call_args.args, ('100.64.0.46', 3001))
        self.assertEqual(list(self.filename.parent.glob('.server-env-*')), [])

    def test_invalid_port_keeps_the_existing_configuration(self):
        text = self.original.replace('3001', 'not-a-port')
        self.filename.write_text(text)
        with patch.object(launcher, 'restart_service') as restart:
            with self.assertRaises(launcher.StartupError):
                launcher.start('localhost', self.filename)
        self.assertEqual(self.filename.read_text(), text)
        restart.assert_not_called()

    def test_mode_update_collapses_duplicate_host_settings_and_clears_the_old_dual_listener_flag(self):
        text = self.original + 'HOST=0.0.0.0\nCLOUDCLI_LISTEN_LOCALHOST=true\n'
        updated = launcher.with_host(text, '127.0.0.1')
        self.assertEqual(updated.count('HOST='), 1)
        self.assertNotIn('CLOUDCLI_LISTEN_LOCALHOST', updated)
        self.assertIn('PRIVATE_VALUE="test secret"', updated)

    def test_interactive_startup_uses_the_last_mode_as_its_default(self):
        with patch.object(launcher.sys.stdin, 'isatty', return_value=True), patch('builtins.input', return_value=''), patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(launcher.choose_mode('localhost'), 'localhost')
            self.assertEqual(launcher.choose_mode('tailnet'), 'tailnet')

    def test_interactive_selection_accepts_both_modes(self):
        with patch.object(launcher.sys.stdin, 'isatty', return_value=True), patch('sys.stdout', new_callable=io.StringIO):
            for answer, expected in [('1', 'localhost'), ('2', 'tailnet'), ('localhost', 'localhost'), ('Tailnet', 'tailnet')]:
                with patch('builtins.input', return_value=answer):
                    self.assertEqual(launcher.choose_mode('tailnet'), expected)

    def test_tailnet_address_validation_rejects_an_unrelated_network(self):
        result = subprocess.CompletedProcess([], 0, stdout='192.168.1.20\n', stderr='')
        with patch.object(launcher.subprocess, 'run', return_value=result):
            with self.assertRaises(launcher.StartupError):
                launcher.tailnet_host()


if __name__ == '__main__':
    unittest.main()
