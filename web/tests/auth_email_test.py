"""Isolated auth ASGI tests; no emulator, real mail, or public identity provider."""
import asyncio
import hashlib
import json
import smtplib
import sqlite3
import ssl
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from starlette.responses import PlainTextResponse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import auth


class AuthEmailTests(unittest.IsolatedAsyncioTestCase):
    base = 'https://lab.example.test'

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='email-auth-test-')
        self.projects = Path(self.tmp.name) / 'projects'
        self.db = self.projects / 'accounts' / 'auth.sqlite'
        self.logs = []
        self.deliveries = []
        auth.set_logger(self.logs.append)
        auth.apply_env(self.config())
        self.original_send = auth._send_email_code
        self.mail = patch.object(auth, '_send_email_code',
                                 side_effect=lambda address, code: self.deliveries.append((address, code)))
        self.send = self.mail.start()
        self.client = self.new_client()

    async def asyncTearDown(self):
        await self.client.aclose()
        self.mail.stop()
        auth.apply_env({'AUTH_ENABLED': '0'})
        auth.set_logger(None)
        self.tmp.cleanup()

    def config(self, **overrides):
        return {
            'AUTH_ENABLED': '1', 'AUTH_EMAIL': '1', 'AUTH_GOOGLE': '1', 'AUTH_GITHUB': '1',
            'AUTH_BASE_URL': self.base, 'AUTH_DB': str(self.db), 'SIM_PROJECT_DIR': str(self.projects),
            'AUTH_RATE_MAX': '1000', 'AUTH_SMTP_HOST': 'smtp.example.test',
            'AUTH_SMTP_FROM': 'no-reply@example.test', 'AUTH_SMTP_USER': 'test-mail-user',
            'AUTH_SMTP_PASSWORD': 'test-only-mail-password', 'AUTH_SMTP_SECURITY': 'starttls',
            'GOOGLE_CLIENT_ID': 'test-google-client', 'GOOGLE_CLIENT_SECRET': 'test-google-secret',
            'GITHUB_CLIENT_ID': 'test-github-client', 'GITHUB_CLIENT_SECRET': 'test-github-secret',
            **overrides,
        }

    def new_client(self, headers=None):
        async def missing(scope, receive, send):
            await PlainTextResponse('not found', status_code=404)(scope, receive, send)
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=auth.AuthMiddleware(missing)),
            base_url=self.base, headers={'Origin': self.base} if headers is None else headers,
        )

    async def start(self, email='learner@example.test', client=None, **extra):
        response = await (client or self.client).post('/auth/email/start', json={
            'email': email, 'next': '/?ui=2&p=local-project', **extra,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def verify(self, started, code=None, client=None, csrf=None):
        token = started['csrf'] if csrf is None else csrf
        return await (client or self.client).post('/auth/email/verify', headers={'X-CSRF-Token': token}, json={
            'challenge': started['challenge'], 'csrf': token,
            'code': self.deliveries[-1][1] if code is None else code,
        })

    def rows(self, query, values=()):
        connection = sqlite3.connect(self.db)
        try:
            return connection.execute(query, values).fetchall()
        finally:
            connection.close()

    async def signed_in(self, provider='github', uid='test-user'):
        sid, _life = auth.finish_login('', {
            'provider': provider, 'provider_user_id': uid,
            'email': 'learner@example.test', 'display_name': 'Test learner',
        })
        self.client.cookies.set(auth.COOKIE, sid, domain='lab.example.test', path='/')
        return sid, auth.session_view(sid)['csrf']

    async def import_projects(self, csrf, items):
        return await self.client.post('/auth/projects/import', headers={'X-CSRF-Token': csrf},
                                      json={'csrf': csrf, 'projects': items})

    def project(self, pid='lamp', marker='first'):
        return {'id': pid, 'name': 'Lamp', 'proj': {
            'id': pid, 'name': 'Lamp', 'mode': 'qemu', 'code': marker, 'parts': [], 'wires': [],
        }}

    async def test_email_signup_rotates_the_session_and_never_stores_the_code_or_browser_key(self):
        started = await self.start('Learner@Example.Test')
        self.assertEqual(self.deliveries[-1][0], 'learner@example.test')
        old_sid = self.client.cookies.get(auth.COOKIE)
        pending = self.rows('SELECT token_hash, code_hash, email FROM email_codes')[0]
        self.assertNotEqual(pending[0], started['challenge'])
        self.assertNotEqual(pending[1], self.deliveries[-1][1])
        self.assertEqual(len(pending[0]), 64)
        self.assertNotIn('code', started)
        self.assertTrue(next(iter(self.client.cookies.jar)).secure)
        response = await self.verify(started)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['redirect'], '/?ui=2&p=local-project&auth_error=ok')
        new_sid = self.client.cookies.get(auth.COOKIE)
        self.assertNotEqual(old_sid, new_sid)
        self.assertFalse(auth.session_view(old_sid)['signed_in'])
        view = (await self.client.get('/auth/session')).json()
        self.assertTrue(view['signed_in'])
        self.assertEqual(view['provider'], 'email')
        self.assertEqual(view['display_name'], 'learner@example.test')
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 1)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM email_codes')[0][0], 0)
        self.assertEqual((await self.verify(started)).status_code, 403)
        self.assertNotIn(self.deliveries[-1][1], '\n'.join(self.logs))
        self.assertNotIn('learner@example.test', '\n'.join(self.logs))

    async def test_returning_email_user_uses_the_same_account_without_linking_oauth(self):
        await self.signed_in('google', 'google-user')
        self.client.cookies.clear()
        started = await self.start()
        self.assertEqual((await self.verify(started)).status_code, 200)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 2)
        self.client.cookies.clear()
        later = time.time() + auth.EMAIL_RESEND_S + 1
        with patch.object(auth.time, 'time', return_value=later):
            again = await self.start('LEARNER@example.test')
            self.assertEqual((await self.verify(again)).status_code, 200)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 2)

    async def test_a_code_with_leading_zeroes_is_verified_as_text(self):
        with patch.object(auth.secrets, 'randbelow', return_value=42):
            started = await self.start()
        self.assertEqual(self.deliveries[-1][1], '000042')
        self.assertEqual((await self.verify(started, '000042')).status_code, 200)

    async def test_wrong_code_has_bounded_attempts_and_cannot_create_an_account(self):
        started = await self.start()
        wrong = '000000' if self.deliveries[-1][1] != '000000' else '999999'
        for attempt in range(auth.EMAIL_ATTEMPTS):
            response = await self.verify(started, wrong)
            self.assertEqual(response.status_code, 429 if attempt == auth.EMAIL_ATTEMPTS - 1 else 422)
        self.assertEqual((await self.verify(started)).status_code, 410)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 0)

    async def test_expired_code_and_missing_or_wrong_session_are_rejected(self):
        started = await self.start()
        async with self.new_client() as other:
            self.assertEqual((await self.verify(started, client=other)).status_code, 403)
        self.assertEqual((await self.verify(started, csrf='wrong-csrf')).status_code, 403)
        self.assertEqual(self.rows('SELECT attempts FROM email_codes')[0][0], 0)
        with patch.object(auth.time, 'time', return_value=time.time() + auth.EMAIL_CODE_S + 1):
            response = await self.verify(started)
        self.assertEqual(response.status_code, 410)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 0)

    async def test_resend_invalidates_the_old_code_and_enforces_cooldown(self):
        first = await self.start()
        first_code = self.deliveries[-1][1]
        response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test'})
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response.headers['retry-after']), 0)
        with patch.object(auth.time, 'time', return_value=time.time() + auth.EMAIL_RESEND_S + 1):
            second = await self.start()
            self.assertEqual((await self.verify(first, first_code)).status_code, 410)
            self.assertEqual((await self.verify(second)).status_code, 200)
        self.assertEqual(len(self.deliveries), 2)

    async def test_a_resent_code_keeps_its_full_lifetime_on_an_old_guest_session(self):
        now = time.time()
        await self.start()
        with patch.object(auth.time, 'time', return_value=now + auth.PENDING_S - 30):
            renewed = await self.start()
        with patch.object(auth.time, 'time', return_value=now + auth.PENDING_S - 30 + auth.EMAIL_CODE_S - 1):
            self.assertEqual((await self.verify(renewed)).status_code, 200)

    async def test_email_and_ip_delivery_limits_apply_before_sending(self):
        now = time.time()
        for index in range(auth.EMAIL_ADDRESS_MAX):
            with patch.object(auth.time, 'time', return_value=now + index * (auth.EMAIL_RESEND_S + 1)):
                await self.start()
        with patch.object(auth.time, 'time', return_value=now + auth.EMAIL_ADDRESS_MAX * (auth.EMAIL_RESEND_S + 1)):
            response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test'})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(len(self.deliveries), auth.EMAIL_ADDRESS_MAX)
        auth.apply_env(self.config(AUTH_DB=str(self.projects / 'accounts' / 'other.sqlite')))
        with patch.object(auth, 'EMAIL_IP_MAX', 2):
            await self.start('one@example.test')
            await self.start('two@example.test')
            response = await self.client.post('/auth/email/start', json={'email': 'three@example.test'})
            self.assertEqual(response.status_code, 429)

    async def test_bad_origin_return_target_and_email_never_send_mail(self):
        for headers in ({}, {'Origin': 'https://other.example.test'}, {'Origin': 'null'}):
            async with self.new_client(headers=headers) as client:
                response = await client.post('/auth/email/start', json={'email': 'learner@example.test'})
                self.assertEqual(response.status_code, 403)
        response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test', 'next': '//other.example.test'})
        self.assertEqual(response.status_code, 400)
        response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test\r\nBcc: other@example.test'})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.deliveries, [])

    async def test_delivery_failure_is_visible_and_revokes_the_pending_code(self):
        self.send.side_effect = smtplib.SMTPException('private provider response')
        response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test'})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['error'], 'delivery')
        self.assertEqual(self.rows('SELECT COUNT(*) FROM email_codes')[0][0], 0)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 0)
        self.assertNotIn('private provider response', '\n'.join(self.logs) + response.text)

    async def test_email_is_off_by_default_and_plain_smtp_is_never_enabled(self):
        for overrides in ({'AUTH_EMAIL': '0'}, {'AUTH_SMTP_HOST': ''}, {'AUTH_SMTP_SECURITY': 'plain'},
                          {'AUTH_SMTP_PASSWORD': ''}):
            auth.apply_env(self.config(**overrides))
            response = await self.client.post('/auth/email/start', json={'email': 'learner@example.test'})
            self.assertEqual(response.status_code, 404)
            self.assertNotIn('set-cookie', response.headers)
        self.assertEqual(self.deliveries, [])

    async def test_unavailable_session_storage_is_an_explicit_service_error(self):
        with patch.object(auth, '_open_db', side_effect=sqlite3.OperationalError('private database detail')):
            response = await self.client.get('/auth/session')
        self.assertEqual(response.status_code, 503)
        self.assertTrue(response.json()['unavailable'])
        self.assertNotIn('private database detail', response.text + '\n'.join(self.logs))

    async def test_email_logout_kills_the_session_and_code_consumption_is_atomic(self):
        started = await self.start()
        with patch.object(auth, '_finish_login_row', side_effect=sqlite3.OperationalError('store unavailable')):
            self.assertEqual((await self.verify(started)).status_code, 503)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM email_codes')[0][0], 1)
        results = await asyncio.gather(self.verify(started), self.verify(started))
        self.assertEqual(sum(response.status_code == 200 for response in results), 1)
        view = (await self.client.get('/auth/session')).json()
        self.assertEqual(self.rows('SELECT COUNT(*) FROM users')[0][0], 1)
        response = await self.client.post('/auth/logout', headers={'X-CSRF-Token': view['csrf']}, json={'csrf': view['csrf']})
        self.assertEqual(response.status_code, 200)
        self.assertFalse((await self.client.get('/auth/session')).json()['signed_in'])

    async def test_smtp_requires_verified_tls_before_credentials_and_message(self):
        events = []

        class Transport:
            def __init__(self, host, port, **kwargs):
                events.append(('connect', host, port, kwargs))

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def ehlo(self):
                events.append('ehlo')

            def starttls(self, context):
                events.append(('tls', context.check_hostname, context.verify_mode))

            def login(self, username, password):
                events.append('login')

            def send_message(self, message):
                events.append('send')
                self_message = message.get_content()
                if '123456' not in self_message:
                    raise AssertionError('The test mail must include its code')
                return {}

        with patch.object(auth.smtplib, 'SMTP', Transport):
            self.original_send('learner@example.test', '123456')
        self.assertTrue(events[2][1])
        self.assertLess(events.index(events[2]), events.index('login'))
        self.assertLess(events.index('login'), events.index('send'))

    async def test_implicit_tls_uses_the_ssl_transport_and_verified_context(self):
        auth.apply_env(self.config(AUTH_SMTP_SECURITY='ssl'))
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.send_message.return_value = {}
        with patch.object(auth.smtplib, 'SMTP_SSL', return_value=connection) as transport:
            self.original_send('learner@example.test', '123456')
        self.assertEqual(transport.call_args.args[1], 465)
        context = transport.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        connection.login.assert_called_once()
        connection.send_message.assert_called_once()

    async def test_account_saves_report_partial_failures_and_keep_previous_versions(self):
        _sid, csrf = await self.signed_in()
        good = self.project()
        huge = self.project('large', 'x' * auth.PROJECT_CAP)
        response = await self.import_projects(csrf, [good, huge])
        self.assertEqual(response.status_code, 207, response.text)
        data = response.json()
        self.assertEqual(data['imported'], 1)
        self.assertEqual(data['rejected'][0]['reason'], 'project_too_large')
        again = await self.import_projects(csrf, [good])
        self.assertEqual(again.json()['unchanged'], 1)
        self.assertEqual(again.json()['imported'], 0)
        self.assertEqual(again.json()['last_saved'], data['last_saved'])
        with patch.object(auth.time, 'time', return_value=data['last_saved']):
            changed = await self.import_projects(csrf, [self.project(marker='changed')])
            self.assertEqual(changed.json()['imported'], 1)
        self.assertEqual((await self.client.get('/auth/projects/lamp')).json()['proj']['code'], 'first')
        projects = (await self.client.get('/auth/projects')).json()['projects']
        self.assertEqual(len(projects), 2)
        self.assertNotEqual(projects[0]['id'], 'lamp')

    async def test_guest_account_saves_keep_the_existing_parts_gate_and_auth_denial(self):
        response = await self.import_projects('unused', [self.project()])
        self.assertEqual(response.status_code, 403)
        with patch('guestparts.blocks', return_value=True):
            rejected = await self.import_projects('unused', [self.project()])
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.json()['error'], 'guest_parts')

    async def test_account_save_limits_are_json_errors_and_versions_obey_the_quota(self):
        _sid, csrf = await self.signed_in()
        response = await self.import_projects(csrf, [self.project(str(index)) for index in range(auth.IMPORT_BATCH + 1)])
        self.assertEqual(response.status_code, 400)
        self.assertIn('message', response.json())
        response = await self.client.post('/auth/projects/import', headers={'X-CSRF-Token': csrf, 'Content-Type': 'application/json'},
                                          content=' ' * (auth.IMPORT_CAP + 1))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()['error'], 'size')
        with patch.object(auth, 'PROJECT_MAX', 1):
            self.assertEqual((await self.import_projects(csrf, [self.project()])).status_code, 200)
            rejected = await self.import_projects(csrf, [self.project(marker='changed')])
            self.assertEqual(rejected.status_code, 422)
            self.assertEqual(rejected.json()['rejected'][0]['reason'], 'account_full')

    async def test_a_full_length_project_id_keeps_a_distinct_snapshot_suffix(self):
        _sid, csrf = await self.signed_in()
        project_id = 'p' * 40
        await self.import_projects(csrf, [self.project(project_id)])
        changed = self.project(project_id, 'changed')
        response = await self.import_projects(csrf, [changed])
        self.assertEqual(response.json()['imported'], 1)
        ids = [row['id'] for row in (await self.client.get('/auth/projects')).json()['projects']]
        digest = hashlib.sha256(json.dumps(changed['proj'], separators=(',', ':'), sort_keys=True).encode()).hexdigest()
        self.assertIn(project_id[:31] + '-' + digest[:8], ids)
        self.assertIn(project_id, ids)

    async def oauth_flow(self, provider):
        from oauth_mock import MockIdP
        idp = MockIdP()
        idp.google_secret = 'test-google-secret'
        idp.github_secret = 'test-github-secret'
        idp.start_thread()
        await self.client.aclose()
        self.base = 'http://127.0.0.1:19000'
        self.client = self.new_client()
        auth.apply_env(self.config(AUTH_TEST_IDP=idp.origin))
        try:
            started = await self.client.get('/auth/' + provider + '?next=%2F%3Fui%3D2')
            self.assertEqual(started.status_code, 302)
            old_sid = self.client.cookies.get(auth.COOKIE)
            async with httpx.AsyncClient() as provider_client:
                approved = await provider_client.get(started.headers['location'])
            self.assertEqual(approved.status_code, 302)
            completed = await self.client.get(approved.headers['location'])
            self.assertEqual(completed.status_code, 302, completed.text)
            self.assertIn('auth_error=ok', completed.headers['location'])
            view = (await self.client.get('/auth/session')).json()
            self.assertTrue(view['signed_in'])
            self.assertEqual(view['provider'], provider)
            self.assertNotEqual(self.client.cookies.get(auth.COOKIE), old_sid)
            self.assertFalse(auth.session_view(old_sid)['signed_in'])
        finally:
            idp.shutdown()
            idp.server_close()

    async def test_existing_google_callback_still_rotates_and_authenticates(self):
        await self.oauth_flow('google')

    async def test_existing_github_callback_still_rotates_and_authenticates(self):
        await self.oauth_flow('github')


if __name__ == '__main__':
    unittest.main()
