import subprocess
import json
import os
import shutil
import tempfile
import unittest
import contextlib
import io
import runpy
import urllib.error
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PolicyGenerationTests(unittest.TestCase):
    def generate(self, source, output):
        return subprocess.run(['python3', str(ROOT / 'scripts/apply-us-policy.py'),
                               str(source), str(output)], capture_output=True, text=True)

    def test_known_upstream_generates_us_policy(self):
        with tempfile.TemporaryDirectory(prefix='naiops-policy-test-') as tmp:
            target = Path(tmp) / 'worker.js'
            result = self.generate(ROOT / 'upstream/_worker.js', target)
            self.assertEqual(result.returncode, 0, result.stderr)
            content = target.read_text()
            self.assertIn("import { connect } from 'cloudflare:sockets';", content)
            self.assertIn('const 管理员密码 = env.ADMIN;', content)
            self.assertIn('function 生成美国通用订阅(', content)
            self.assertIn('反代IP: 美国出口', content)

    def test_changed_anchor_stops_without_overwriting_output(self):
        with tempfile.TemporaryDirectory(prefix='naiops-policy-test-') as tmp:
            source = Path(tmp) / 'input.js'
            source.write_text((ROOT / 'upstream/_worker.js').read_text().replace(
                'function 创建请求TCP连接器(request)', 'function upstreamRenamedConnector(request)'))
            target = Path(tmp) / 'output.js'
            target.write_text('keep previous release')
            result = self.generate(source, target)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_text(), 'keep previous release')

    def test_policy_preserves_unrelated_upstream_code(self):
        with tempfile.TemporaryDirectory(prefix='naiops-policy-test-') as tmp:
            source = Path(tmp) / 'input.js'
            source.write_text((ROOT / 'upstream/_worker.js').read_text() + '\n// upstream regression marker\n')
            target = Path(tmp) / 'output.js'
            result = self.generate(source, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('// upstream regression marker', target.read_text())

class ReleaseTests(unittest.TestCase):
    def fixture(self, directory):
        repo = Path(directory) / 'repo'
        (repo / 'scripts').mkdir(parents=True)
        shutil.copyfile(ROOT / 'scripts/build-release.py', repo / 'scripts/build-release.py')
        (repo / '_worker.js').write_text("const revision = '__NAIOPS_RELEASE_SHA__';\n")
        (repo / 'LICENSE').write_text('fixture license')
        subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
        subprocess.run(['git', 'add', '_worker.js', 'LICENSE'], cwd=repo, check=True)
        subprocess.run(['git', '-c', 'user.name=Pipeline Test', '-c', 'user.email=pipeline@example.invalid',
                        'commit', '-qm', 'fixture'], cwd=repo, check=True)
        sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
        return repo, sha

    def test_release_stamps_exact_commit(self):
        with tempfile.TemporaryDirectory(prefix='naiops-release-test-') as tmp:
            repo, sha = self.fixture(tmp)
            output = Path(tmp) / 'release/assets'
            result = subprocess.run(['python3', str(repo / 'scripts/build-release.py'), sha, str(output)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(sha, (output / '_worker.js').read_text())
            self.assertEqual(json.loads((output.parent / 'release-manifest.json').read_text())['revision'], sha)

    def test_wrong_revision_cannot_build_a_release(self):
        with tempfile.TemporaryDirectory(prefix='naiops-release-test-') as tmp:
            repo, sha = self.fixture(tmp)
            output = Path(tmp) / 'release/assets'
            result = subprocess.run(['python3', str(repo / 'scripts/build-release.py'), '0' * 40, str(output)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

class ApprovalTests(unittest.TestCase):
    def run_guard(self, environment):
        with tempfile.TemporaryDirectory(prefix='naiops-approval-test-') as tmp:
            stub = Path(tmp) / 'gh'
            stub.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                            'env=' + repr(environment) + '\n'
                            "print(json.dumps({'branch_policies':[{'name':'main','type':'branch'}]} if sys.argv[-1].endswith('deployment-branch-policies') else env))\n")
            stub.chmod(0o700)
            return subprocess.run(['python3', str(ROOT / 'scripts/check-deploy-approval.py')],
                                  env={**os.environ, 'PATH':tmp + os.pathsep + os.environ['PATH']},
                                  capture_output=True, text=True)

    def protected_environment(self):
        return {'can_admins_bypass':False, 'deployment_branch_policy':{'custom_branch_policies':True},
                'protection_rules':[{'type':'required_reviewers','reviewers':[
                    {'type':'User','reviewer':{'login':'duiniwukenaihe'}}]}]}

    def test_owner_approval_environment_is_accepted(self):
        result = self.run_guard(self.protected_environment())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_owner_approval_stops_deployment(self):
        environment = self.protected_environment()
        environment['protection_rules'] = []
        self.assertNotEqual(self.run_guard(environment).returncode, 0)

    def test_admin_bypass_stops_deployment(self):
        environment = self.protected_environment()
        environment['can_admins_bypass'] = True
        self.assertNotEqual(self.run_guard(environment).returncode, 0)

    def test_another_reviewer_cannot_replace_owner_approval(self):
        environment = self.protected_environment()
        environment['protection_rules'][0]['reviewers'].append(
            {'type':'User', 'reviewer':{'login':'another-reviewer'}})
        self.assertNotEqual(self.run_guard(environment).returncode, 0)

class LiveReleaseTests(unittest.TestCase):
    def check(self, returned_revision):
        def response(request, timeout):
            if not request.get_header('User-agent'):
                raise urllib.error.HTTPError(request.full_url, 403, 'error code: 1010', {}, io.BytesIO())
            return io.BytesIO(json.dumps({'status':'ready', 'revision':returned_revision}).encode())
        with patch('sys.argv', ['check-live-release.py', 'a' * 40]), \
             patch('urllib.request.urlopen', side_effect=response), \
             patch('time.sleep'), contextlib.redirect_stdout(io.StringIO()):
            try:
                runpy.run_path(str(ROOT / 'scripts/check-live-release.py'), run_name='__main__')
            except SystemExit as error:
                return 1, str(error)
        return 0, ''

    def test_live_check_identifies_client_and_accepts_exact_revision(self):
        code, message = self.check('a' * 40)
        self.assertEqual(code, 0, message)

    def test_live_check_still_rejects_another_deployed_revision(self):
        code, message = self.check('b' * 40)
        self.assertNotEqual(code, 0)
        self.assertIn('Ready state or deployed revision does not match', message)

if __name__ == '__main__':
    unittest.main()
