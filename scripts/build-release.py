"""Build only the exact checked-out Git commit, outside the source tree."""
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
revision, directory = sys.argv[1:]
if not re.fullmatch('[0-9a-f]{40}', revision):
    raise SystemExit('Release needs a full 40-character commit SHA')
current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
if current != revision:
    raise SystemExit('Checkout does not match approved revision')
output = Path(directory).resolve()
if output == ROOT or ROOT in output.parents:
    raise SystemExit('Release output must be outside the repository')
output.mkdir(parents=True, exist_ok=True)
worker = subprocess.check_output(['git', 'show', revision + ':_worker.js'], cwd=ROOT).decode()
if worker.count('__NAIOPS_RELEASE_SHA__') != 1:
    raise SystemExit('Missing or duplicated release stamp')
worker = worker.replace('__NAIOPS_RELEASE_SHA__', revision)
(output / '_worker.js').write_text(worker)
(output / '_routes.json').write_text('{"version":1,"include":["/*"],"exclude":[]}\n')
(output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>naiops</title>naiops service\n')
(output / 'LICENSE').write_bytes(subprocess.check_output(['git', 'show', revision + ':LICENSE'], cwd=ROOT))
manifest = {'revision': revision, 'worker_sha256': hashlib.sha256(worker.encode()).hexdigest()}
(output.parent / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
with zipfile.ZipFile(output.parent / 'naiops-us-pages.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ['_worker.js', '_routes.json', 'index.html', 'LICENSE']:
        archive.write(output / name, name)
print(json.dumps(manifest))
