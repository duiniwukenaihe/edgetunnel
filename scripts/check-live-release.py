"""Check readiness and revision without claiming proxy or login validation."""
import json
import re
import sys
import time
import urllib.request

revision = sys.argv[1]
if not re.fullmatch('[0-9a-f]{40}', revision):
    raise SystemExit('Expected release SHA is invalid')
last = 'not checked'
for attempt in range(6):
    try:
        request = urllib.request.Request('https://us.naiops.ccwu.cc/healthz', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=15) as response:
            status = json.load(response)
        if status.get('status') == 'ready' and status.get('revision') == revision:
            print('Live readiness and release revision verified:', revision)
            print('US egress, client failover and ChatGPT login require separate validation.')
            break
        last = 'Ready state or deployed revision does not match'
    except (OSError, ValueError) as error:
        last = str(error)
    if attempt < 5:
        time.sleep(5)
else:
    raise SystemExit('Live release verification failed: ' + last)
