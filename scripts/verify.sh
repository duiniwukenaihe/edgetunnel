#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1
python3 scripts/verify-source.py
python3 -m unittest discover -s tests -p 'test_pipeline.py'
node --input-type=module --check < _worker.js
NAIOPS_SOURCE="$PWD/_worker.js" node --test --test-reporter=tap tests/*.test.cjs
