"""Check provenance and reproducibility before executing regression tests."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
lock = json.loads((ROOT / 'upstream/version.json').read_text())
if lock['repository'] != 'cmliu/edgetunnel' or not re.fullmatch('[0-9a-f]{40}', lock['commit']):
    raise SystemExit('Invalid upstream identity')
raw = (ROOT / 'upstream/_worker.js').read_bytes()
if hashlib.sha256(raw).hexdigest() != lock['worker_sha256']:
    raise SystemExit('Upstream checksum mismatch')
spec = importlib.util.spec_from_file_location('us_policy', ROOT / 'scripts/apply-us-policy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if module.apply_policy(raw.decode()) != (ROOT / '_worker.js').read_text():
    raise SystemExit('Generated worker differs from upstream plus custom policy')
print('Provenance and generated source match:', lock['commit'])
