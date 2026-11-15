#!/usr/bin/env python3
"""Build WordCraft's complete browser graph with pinned fonts/translations and public notices."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def git(root, *args):
    return subprocess.check_output(['git', '--no-optional-locks', '-C', str(root), *args], text=True).strip()


def direct(path):
    path = Path(path).absolute()
    if '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Direct paths without symlink ancestors required')
    if path.is_relative_to(ROOT) or ROOT.is_relative_to(path):
        raise ValueError('Build outputs/cache must be outside source')
    return path


def verify_inputs(fonts, translations, source=ROOT):
    font_pin = re.findall(r'craft-fonts-ref:\s*([0-9a-f]{40})', (source / '.github/workflows/release.yml').read_text())
    translation_pin = (source / 'craft-i18n.rev').read_text().strip()
    if len(font_pin) != 1:
        raise ValueError('Review the source font pin before building')
    for folder, commit in [(fonts, font_pin[0]), (translations, translation_pin)]:
        if git(folder, 'rev-parse', 'HEAD') != commit or git(folder, 'status', '--porcelain'):
            raise ValueError('Build input must be a clean checkout at its source-declared pin')
    for line in (fonts / 'fonts/manifest.txt').read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        fields = [part.strip() for part in line.split(' | ')]
        asset, notice, digest = fonts / fields[2], fonts / fields[5], fields[6]
        if not asset.resolve().is_relative_to(fonts.resolve()) or asset.is_symlink() or not notice.is_file() or hashlib.sha256(asset.read_bytes()).hexdigest() != digest:
            raise ValueError('Font payload/notice differs from the pinned manifest')
    return {'craft-fonts': font_pin[0], 'craft-i18n': translation_pin}


class InlineModules(HTMLParser):
    """Locate Trunk's generated module exactly; preserve its initializer unchanged."""
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.lines = [0]
        self.lines.extend(match.end() for match in re.finditer('\n', text))
        self.pending = None
        self.modules = []
        self.feed(text)

    def source_offset(self):
        row, column = self.getpos()
        return self.lines[row - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag != 'script':
            return
        attrs = dict(attrs)
        if 'src' not in attrs:
            if attrs.get('type') != 'module':
                raise ValueError('Unexpected inline script; review its build ownership')
            start = self.source_offset()
            self.pending = (start, start + len(self.get_starttag_text()))

    def handle_endtag(self, tag):
        if tag == 'script' and self.pending:
            start, content = self.pending
            self.modules.append((start, self.source_offset() + len('</script>'), self.text[content:self.source_offset()]))
            self.pending = None


def finalize(site, fonts, translations, source=ROOT, profile='release'):
    pins = verify_inputs(fonts, translations, source)
    html = (site / 'index.html').read_text()
    modules = InlineModules(html).modules
    if len(modules) != 1:
        raise ValueError('Expected one generated Trunk initializer; review the new output graph')
    start, end, code = modules[0]
    name = 'wordcraft-loader-' + hashlib.sha256(code.encode()).hexdigest()[:16] + '.mjs'
    (site / name).write_text(code)
    (site / 'index.html').write_text(html[:start] + '<script type="module" src="./' + name + '"></script>' + html[end:])
    # Static external module preserves Trunk's initializer and works with the
    # assembly's script-src self policy; no global unsafe-inline exception.
    notices = site / 'notices'
    notices.mkdir()
    for label in ['README.md', 'LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYRIGHT', 'NOTICE', 'ATTRIBUTION.md']:
        if (source / label).is_file():
            shutil.copy2(source / label, notices / label)
    for notice in fonts.glob('fonts/*/OFL.txt'):
        shutil.copy2(notice, notices / ('OFL-' + notice.parent.name + '.txt'))
    for name in ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE']:
        if (translations / name).is_file():
            shutil.copy2(translations / name, notices / ('craft-i18n-' + name))
    records = []
    for path in sorted(site.rglob('*')):
        if path.is_symlink():
            raise ValueError('Public graph must contain regular artifacts, not external links')
        if path.is_file():
            records.append({'path': path.relative_to(site).as_posix(), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if not any(record['path'].endswith('.wasm') for record in records):
        raise ValueError('Missing WebAssembly artifact')
    receipt = {'schema': 'webos-component-build/1', 'component': 'wordcraft', 'sourceCommit': git(source, 'rev-parse', 'HEAD'),
               'profile': profile, 'buildInputs': pins, 'cargoLockSHA256': hashlib.sha256((source / 'Cargo.lock').read_bytes()).hexdigest(),
               'tools': {tool: subprocess.check_output([tool, '--version'], text=True).strip() for tool in ['rustc', 'cargo', 'trunk']}, 'files': records, 'totalBytes': sum(record['bytes'] for record in records),
               'qualification': 'Built artifact graph; browser/host/agent/release acceptance is separate'}
    (site / 'component-build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--fonts', type=Path, required=True)
    parser.add_argument('--translations', type=Path, required=True)
    parser.add_argument('--profile', choices=['development', 'release'], default='development')
    args = parser.parse_args()
    output, cache = direct(args.output), direct(args.cache)
    fonts, translations = args.fonts.absolute(), args.translations.absolute()
    if output.exists() or output.is_relative_to(cache) or cache.is_relative_to(output):
        parser.error('Use a new output directory disjoint from the private cache')
    if git(ROOT, 'status', '--porcelain'):
        parser.error('Commit/review component changes before building reproducible artifacts')
    verify_inputs(fonts, translations)
    source_commit = git(ROOT, 'rev-parse', 'HEAD')
    for executable in ['cargo', 'rustc', 'trunk']:
        if not shutil.which(executable):
            parser.error('Required build tool unavailable: ' + executable)
    version = subprocess.check_output(['trunk', '--version'], text=True).strip()
    if version != 'trunk 0.21.14':
        parser.error('This build recipe is qualified with pinned Trunk 0.21.14')
    if shutil.disk_usage(cache.parent).free < 2 * 1024 ** 3:
        parser.error('Insufficient free space for a new build; inspect disk capacity first')
    os.umask(0o077)
    marker = cache / 'wordcraft-build-cache.json'
    if not cache.exists():
        cache.mkdir(mode=0o700)
        marker.write_text(json.dumps({'schema': 'webos-wordcraft-build-cache/1'}) + '\n')
    else:
        info = cache.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700 or not marker.is_file() or json.loads(marker.read_text()).get('schema') != 'webos-wordcraft-build-cache/1':
            parser.error('Unknown or nonprivate build cache; preserve it for inspection')
    env = dict(os.environ, CARGO_TARGET_DIR=str(cache / 'target'), XDG_CACHE_HOME=str(cache / 'tools'), CARGO_BUILD_JOBS=os.environ.get('CARGO_BUILD_JOBS', '1'),
               CRAFT_FONTS_DIR=str(fonts), CRAFT_FONTS_REQUIRED='1', CRAFT_I18N_DIR=str(translations), CRAFT_I18N_REQUIRED='1')
    # Trunk 0.21.14 parses inherited NO_COLOR as a boolean; NO_COLOR=1 fails.
    env.pop('NO_COLOR', None)
    command = ['trunk', 'build', '--locked', '--skip-version-check', '--color', 'never', '--dist', str(output), '--public-url', './']
    if args.profile == 'release':
        command += ['--release', str(ROOT / 'apps/wordcraft-web/index.html')]
    else:
        # The same complete engine and assets, without a release-only size
        # optimization pass on every development rebuild. No codec/font/UI is removed.
        command += ['--cargo-profile', 'dev', str(ROOT / 'webos/index.html')]
    subprocess.run(command, cwd=ROOT / 'apps/wordcraft-web', env=env, check=True)
    if git(ROOT, 'rev-parse', 'HEAD') != source_commit or git(ROOT, 'status', '--porcelain'):
        raise RuntimeError('Source changed during the build; preserve outputs as unqualified and build a reviewed commit')
    receipt = finalize(output, fonts, translations, profile=args.profile)
    print(json.dumps({'component': 'wordcraft', 'output': str(output), 'totalBytes': receipt['totalBytes'], 'files': len(receipt['files'])}))


if __name__ == '__main__':
    main()
