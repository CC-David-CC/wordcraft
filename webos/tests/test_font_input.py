"""The WebOS build selects its maintained font pin and embeds math on the web."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_input_build', ROOT / 'webos/build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class FontInputTests(unittest.TestCase):
    def test_source_pin_is_authoritative_and_dirty_inputs_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            pins = []
            for name in ('fonts', 'translations'):
                repo = base / name
                repo.mkdir()
                subprocess.run(['git', 'init', '-q', str(repo)], check=True)
                if name == 'fonts':
                    (repo / 'fonts').mkdir()
                    (repo / 'fonts/manifest.txt').write_text('# No payload in this fixture\n')
                else:
                    (repo / 'NOTICE').write_text('Synthetic translation fixture\n')
                subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
                subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Fixture',
                                '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], check=True)
                pins.append(subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip())
            source = base / 'source'
            (source / 'webos').mkdir(parents=True)
            (source / 'webos/craft-fonts.rev').write_text(pins[0] + '\n')
            (source / 'craft-i18n.rev').write_text(pins[1] + '\n')
            (source / 'Cargo.toml').write_text('egui = { git = "' + build.EGUI_UPSTREAM + '", rev = "' + 'a' * 40 + '" }\ncraft_update = { git = "' + build.CRAFT_LIBS_UPSTREAM + '", rev = "' + 'b' * 40 + '" }\n')
            self.assertEqual(build.verify_inputs(base / 'fonts', base / 'translations', source)['craft-fonts'], pins[0])
            (source / 'webos/craft-fonts.rev').write_text('b' * 40 + '\n')
            with self.assertRaises(ValueError):
                build.verify_inputs(base / 'fonts', base / 'translations', source)
            (source / 'webos/craft-fonts.rev').write_text(pins[0] + '\n')
            (base / 'fonts/fonts/manifest.txt').write_text('# Changed after pinning\n')
            with self.assertRaises(ValueError):
                build.verify_inputs(base / 'fonts', base / 'translations', source)

    def test_actual_font_build_script_keeps_math_in_wasm(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'fonts').mkdir()
            for name in ('math.otf', 'japanese.ttf'):
                (base / 'fonts' / name).write_bytes(b'Build-script path fixture only')
            (base / 'fonts/manifest.txt').write_text(
                'Math Fixture | Regular | fonts/math.otf | Zmth | OFL-1.1\n'
                'Japanese Fixture | Regular | fonts/japanese.ttf | Jpan | OFL-1.1\n')
            exe = base / 'font-build'
            subprocess.run(['rustc', '--edition=2024', str(ROOT / 'crates/fonts/build.rs'), '-o', str(exe)], check=True)
            environment = dict(os.environ, CRAFT_FONTS_DIR=str(base), OUT_DIR=str(base), CARGO_CFG_TARGET_ARCH='wasm32')
            subprocess.run([str(exe)], env=environment, check=True, capture_output=True)
            generated = (base / 'craft_fonts.rs').read_text()
            self.assertIn('Math Fixture', generated)
            self.assertIn('math.otf', generated)
            self.assertNotIn('Japanese Fixture', generated)


if __name__ == '__main__':
    unittest.main()
