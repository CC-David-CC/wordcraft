"""Real local Git transport for maintained revisions without global configuration."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('wordcraft_build', Path(__file__).resolve().parents[1] / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ForkTransportTests(unittest.TestCase):
    def test_explicit_provider_serves_pin_and_preserves_caller_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            origin = root / 'egui.git'
            subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(origin)], check=True, capture_output=True)
            def git(*args, input=None):
                return subprocess.check_output(['git', '-C', str(origin), *args], input=input, text=True).strip()
            tree = git('mktree', input='')
            commit = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, input='Fixture only\n')
            git('update-ref', 'refs/heads/main', commit)
            source = root / 'source'; source.mkdir()
            (source / 'Cargo.toml').write_text('egui = { git = "' + build.EGUI_UPSTREAM + '", rev = "' + commit + '" }\n')
            environment = dict(os.environ, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.logAllRefUpdates', GIT_CONFIG_VALUE_0='false')
            snapshot = dict(environment)
            scoped = build.scoped_egui_environment(origin, environment, source)
            result = subprocess.check_output(['git', 'ls-remote', build.EGUI_UPSTREAM, 'refs/heads/main'], env=scoped, text=True)
            self.assertEqual(result.split()[0], commit)
            self.assertEqual(environment, snapshot)
            self.assertEqual(scoped['GIT_CONFIG_VALUE_0'], 'false')
            self.assertEqual(scoped['CARGO_NET_GIT_FETCH_WITH_CLI'], 'true')

    def test_missing_pin_is_refused_before_transport_is_configured(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); origin = root / 'egui.git'; source = root / 'source'; source.mkdir()
            subprocess.run(['git', 'init', '--bare', str(origin)], check=True, capture_output=True)
            (source / 'Cargo.toml').write_text('egui = { git = "' + build.EGUI_UPSTREAM + '", rev = "' + 'a' * 40 + '" }\n')
            with self.assertRaises(subprocess.CalledProcessError):
                build.scoped_egui_environment(origin, {}, source)


if __name__ == '__main__':
    unittest.main()
