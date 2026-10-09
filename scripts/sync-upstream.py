"""Fetch one upstream revision; regenerate only owned source files."""
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

git('fetch', '--no-tags', '--depth=1', 'https://github.com/cmliu/edgetunnel.git', 'main')
revision = git('rev-parse', 'FETCH_HEAD').decode().strip()
current = json.loads((ROOT / 'upstream/version.json').read_text())
changed = revision != current['commit']
if changed:
    raw = git('show', revision + ':_worker.js')
    if git('show', revision + ':LICENSE') != (ROOT / 'LICENSE').read_bytes():
        raise SystemExit('Upstream license changed; manual review required')
    spec = importlib.util.spec_from_file_location('us_policy', ROOT / 'scripts/apply-us-policy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    generated = module.apply_policy(raw.decode())
    lock = {'repository': 'cmliu/edgetunnel', 'commit': revision,
            'worker_sha256': hashlib.sha256(raw).hexdigest()}
    (ROOT / '_worker.js').write_text(generated)
    (ROOT / 'upstream/_worker.js').write_bytes(raw)
    (ROOT / 'upstream/version.json').write_text(json.dumps(lock, indent=2) + '\n')
if os.environ.get('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('changed=' + str(changed).lower() + '\nupstream=' + revision + '\n')
print('upstream=' + revision, 'changed=' + str(changed).lower())
