"""Stop if production no longer requires the owner's review."""
import json
import subprocess

REPO = 'duiniwukenaihe/edgetunnel'
ENVIRONMENT = 'cloudflare-production'
def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/' + REPO + path], text=True))

environment = api('/environments/' + ENVIRONMENT)
reviewers = [reviewer for rule in environment.get('protection_rules', [])
             if rule['type'] == 'required_reviewers' for reviewer in rule['reviewers']]
if not any(r['type'] == 'User' and r['reviewer']['login'] == 'duiniwukenaihe' for r in reviewers):
    raise SystemExit('Cloudflare release requires owner approval; environment is not configured')
if environment.get('can_admins_bypass', True):
    raise SystemExit('Production approvals must not allow administrator bypass')
if not (environment.get('deployment_branch_policy') or {}).get('custom_branch_policies'):
    raise SystemExit('Production environment must be restricted to main')
policies = api('/environments/' + ENVIRONMENT + '/deployment-branch-policies')['branch_policies']
if len(policies) != 1 or policies[0]['name'] != 'main' or policies[0].get('type', 'branch') != 'branch':
    raise SystemExit('Production deployment branch must be main only')
print('Owner approval and main-only environment rules verified')
