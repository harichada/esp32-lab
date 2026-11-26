"""Sign-in with a local provider stand-in. Nothing here contacts Google or GitHub."""
import hashlib, http.client, json, os, shutil, sqlite3, stat, sys, tempfile, unittest, urllib.parse
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import auth
import https
import server
from oauth_mock import ACCESS_TOKEN, MockIdP

GOOGLE_SECRET = 'Zq7-oauth-secret-do-not-leak'
GITHUB_SECRET = 'Hk4-github-secret-do-not-leak'
REFRESH = 'refresh-should-not-be-stored'


def _pairs(resp):
    return [(k.lower(), v) for k, v in resp.getheaders()]


def _header(pairs, name):
    vals = [v for k, v in pairs if k == name.lower()]
    if not vals:
        return None
    return vals[0] if len(vals) == 1 else vals


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='auth-test-')
        cls.proj = os.path.join(cls.tmp, 'projects')
        cls.db = os.path.join(cls.proj, 'accounts', 'auth.sqlite')
        os.makedirs(cls.proj)
        cls.idp = MockIdP()
        cls.idp.google_secret = GOOGLE_SECRET
        cls.idp.github_secret = GITHUB_SECRET
        cls.idp.start_thread()
        cls.logs = []
        auth.set_logger(lambda msg: cls.logs.append(str(msg)))
        cls.http = https.Background(server.app, '127.0.0.1', 0).start()
        cls.port = cls.http.http_port
        cls._enable()

    @classmethod
    def tearDownClass(cls):
        auth.apply_env({'AUTH_ENABLED': '0'})
        https.apply_env({})
        try:
            cls.idp.shutdown()
        except Exception:
            pass
        try:
            cls.http.stop()
        except Exception:
            pass

    @classmethod
    def _config(cls, **over):
        cfg = {
            'AUTH_ENABLED': '1',
            'AUTH_GOOGLE': '1',
            'AUTH_GITHUB': '1',
            'AUTH_BASE_URL': 'http://127.0.0.1:%d' % cls.port,
            'AUTH_TEST_IDP': cls.idp.origin,
            'AUTH_DB': cls.db,
            'AUTH_HTTP_TIMEOUT_S': '1',
            'AUTH_RATE_MAX': '500',
            'AUTH_RATE_WINDOW_S': '60',
            'AUTH_SESSION_DAYS': '30',
            'GOOGLE_CLIENT_ID': 'google-client',
            'GOOGLE_CLIENT_SECRET': GOOGLE_SECRET,
            'GITHUB_CLIENT_ID': 'github-client',
            'GITHUB_CLIENT_SECRET': GITHUB_SECRET,
            'SIM_PROJECT_DIR': cls.proj,
        }
        cfg.update(over)
        return cfg

    @classmethod
    def _enable(cls, **over):
        auth.apply_env(cls._config(**over))

    def setUp(self):
        self.idp.mode = 'ok'
        self._enable()
        https.apply_env({})
        self.logs.clear()

    def _req(self, method, url, headers=None, body=None):
        if url.startswith('http://'):
            parsed = urllib.parse.urlsplit(url)
            host, port = parsed.hostname, parsed.port
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
        else:
            host, port = '127.0.0.1', self.port
            path = url
        conn = http.client.HTTPConnection(host, port, timeout=8)
        hdrs = {'Host': '%s:%s' % (host, port)}
        if headers:
            hdrs.update(headers)
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        payload = resp.read()
        pairs = _pairs(resp)
        conn.close()
        return resp.status, pairs, payload

    def _cookie(self, pairs):
        raw = _header(pairs, 'set-cookie')
        self.assertIsNotNone(raw)
        self.assertIsInstance(raw, str)
        parts = [part.strip() for part in raw.split(';')]
        name, _, value = parts[0].partition('=')
        flags = {part.lower() for part in parts[1:]}
        attrs = {}
        for part in parts[1:]:
            if '=' in part:
                key, val = part.split('=', 1)
                attrs[key.strip().lower()] = val.strip()
        return name, value, flags, attrs

    def _jar_header(self, jar):
        return '; '.join('%s=%s' % item for item in jar.items())

    def _query(self, url):
        return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query, keep_blank_values=True)

    def _start(self, provider, nxt='/'):
        status, pairs, body = self._req('GET', '/auth/%s?next=%s' % (provider, urllib.parse.quote(nxt, safe='')))
        self.assertEqual(status, 302, body)
        location = _header(pairs, 'location')
        self.assertTrue(location.startswith(self.idp.origin + '/' + provider + '/authorize'), location)
        name, value, flags, attrs = self._cookie(pairs)
        self.assertEqual(name, 'cl_session')
        self.assertIn('httponly', flags)
        self.assertNotIn('secure', flags)
        self.assertEqual(attrs.get('samesite'), 'lax')
        self.assertNotIn('domain', attrs)
        return location, {name: value}, attrs, body

    def _authorize(self, location):
        status, pairs, body = self._req('GET', location)
        self.assertEqual(status, 302, body)
        return _header(pairs, 'location')

    def _callback(self, url, jar):
        return self._req('GET', url, headers={'Cookie': self._jar_header(jar)})

    def _finish(self, provider, nxt='/'):
        location, jar, _attrs, _body = self._start(provider, nxt)
        callback = self._authorize(location)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        landed = _header(pairs, 'location')
        self.assertIn('auth_error=ok', landed)
        name, value, _flags, _attrs = self._cookie(pairs)
        self.assertNotEqual(value, jar['cl_session'])
        old = jar['cl_session']
        jar[name] = value
        return jar, old, landed, body

    def _session(self, jar):
        status, pairs, body = self._req('GET', '/auth/session', headers={'Cookie': self._jar_header(jar)})
        self.assertEqual(status, 200, body)
        return json.loads(body), pairs

    def _scope_of(self, provider):
        location, _jar, _attrs, _body = self._start(provider, '/')
        params = self._query(location)
        self.assertEqual(len(params.get('scope') or []), 1)
        return params['scope'][0], params

    def test_provider_scopes_are_exact(self):
        self.assertEqual(auth.GOOGLE_SCOPE, 'openid email profile')
        self.assertEqual(auth.GITHUB_SCOPE, 'read:user user:email')
        google, gparams = self._scope_of('google')
        github, hparams = self._scope_of('github')
        self.assertEqual(google, 'openid email profile')
        self.assertEqual(github, 'read:user user:email')
        self.assertEqual(gparams.get('code_challenge_method'), ['S256'])
        self.assertEqual(hparams.get('code_challenge_method'), ['S256'])
        self.assertNotIn('access_type', gparams)
        self.assertNotIn('access_type', hparams)
        self.assertIn('nonce', gparams)
        self.assertNotIn('nonce', hparams)
        self.assertNotIn(GOOGLE_SECRET, google + github)
        for secret in (GOOGLE_SECRET, GITHUB_SECRET, ACCESS_TOKEN, REFRESH):
            self.assertNotIn(secret, '\n'.join(self.logs))

    def test_google_off_is_404_and_github_still_starts(self):
        self._enable(AUTH_GOOGLE='0', AUTH_GITHUB='1')
        status, pairs, body = self._req('GET', '/auth/session')
        self.assertEqual(status, 200)
        view = json.loads(body)
        self.assertEqual(view['providers'], {'google': False, 'github': True})
        self.assertIsNone(_header(pairs, 'set-cookie'))
        for method, path in (
            ('GET', '/auth/google'),
            ('GET', '/auth/google/callback'),
            ('GET', '/auth/google/extra'),
            ('POST', '/auth/google'),
            ('POST', '/auth/google/callback?code=abc'),
        ):
            status, pairs, body = self._req(method, path, body=b'' if method == 'POST' else None)
            self.assertEqual(status, 404, (method, path, body))
            self.assertEqual(body, b'not found')
            self.assertIsNone(_header(pairs, 'location'))
            self.assertIsNone(_header(pairs, 'set-cookie'))
        calls = self.idp.token_calls
        scope, params = self._scope_of('github')
        self.assertEqual(scope, 'read:user user:email')
        self.assertEqual(params.get('client_id'), ['github-client'])
        self.assertEqual(self.idp.token_calls, calls)

    def test_google_login_rotates_the_session_and_stores_no_token(self):
        jar, old, landed, body = self._finish('google', '/?view=schematic')
        self.assertIn('view=schematic', landed)
        self.assertNotIn('accounts.google.com', landed)
        for secret in (GOOGLE_SECRET, GITHUB_SECRET, ACCESS_TOKEN, REFRESH):
            self.assertNotIn(secret.encode(), body)
        view, _pairs = self._session(jar)
        self.assertTrue(view['signed_in'])
        self.assertEqual(view['display_name'], 'Ada Lovelace')
        self.assertEqual(view['provider'], 'google')
        self.assertNotIn('email', view)
        old_view, _ = self._session({'cl_session': old})
        self.assertFalse(old_view['signed_in'])
        last = json.loads(self._req('GET', self.idp.origin + '/control/last')[2])
        self.assertTrue(last['token']['verifier_matches'])
        self.assertTrue(last['token']['secret_ok'])
        blob = Path(self.db).read_bytes()
        for secret in (GOOGLE_SECRET, GITHUB_SECRET, ACCESS_TOKEN, REFRESH):
            self.assertNotIn(secret.encode(), blob)
        with sqlite3.connect(self.db) as conn:
            rows = conn.execute('SELECT provider, email FROM users').fetchall()
        self.assertIn(('google', 'ada@example.com'), rows)

    def test_github_login_is_a_separate_account(self):
        jar, _old, _landed, _body = self._finish('github', '/')
        view, _pairs = self._session(jar)
        self.assertEqual(view['provider'], 'github')
        self.assertEqual(view['display_name'], 'Ada Lovelace')
        with sqlite3.connect(self.db) as conn:
            rows = conn.execute(
                'SELECT provider, provider_user_id FROM users WHERE email = ?', ('ada@example.com',)
            ).fetchall()
        providers = {row[0] for row in rows}
        self.assertIn('github', providers)
        if 'google' in providers:
            self.assertGreaterEqual(len(rows), 2)

    def test_cancel_returns_to_the_same_page(self):
        self.idp.mode = 'cancel'
        location, jar, _attrs, _body = self._start('google', '/?p=lamp1')
        callback = self._authorize(location)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        landed = _header(pairs, 'location')
        self.assertIn('auth_error=cancelled', landed)
        self.assertIn('p=lamp1', landed)
        self.assertNotIn(b'error_description', body)

    def test_outage_and_timeout_are_sentences(self):
        location, jar, _attrs, _body = self._start('google', '/')
        callback = self._authorize(location)
        self.idp.mode = 'outage'
        status, _pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 200)
        text = body.decode('utf-8')
        self.assertIn('Sign-in could not be completed. Your work is still on this device.', text)
        self.assertIn('Try again', text)
        self.assertNotIn('{', text[:1])
        self.logs.clear()
        location, jar, _attrs, _body = self._start('github', '/')
        callback = self._authorize(location)
        self.idp.mode = 'timeout'
        status, _pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 200)
        self.assertIn(
            b'The sign-in service did not respond. Your work is still on this device.', body,
        )
        self.assertTrue(any('reason=timeout' in line for line in self.logs))

    def test_state_mismatch_does_not_burn_the_pending_login(self):
        before = self.idp.token_calls
        location, jar, _attrs, _body = self._start('google', '/')
        callback = self._authorize(location)
        parsed = urllib.parse.urlsplit(callback)
        params = urllib.parse.parse_qs(parsed.query)
        state = params['state'][0]
        bad = state[:-1] + ('A' if state[-1] != 'A' else 'B')
        wrong = urllib.parse.urlunsplit((
            parsed.scheme, parsed.netloc, parsed.path,
            urllib.parse.urlencode({'code': params['code'][0], 'state': bad}), '',
        ))
        status, _pairs, body = self._callback(wrong, jar)
        self.assertEqual(status, 200, body)
        self.assertIn(b'Sign-in could not be confirmed', body)
        self.assertEqual(self.idp.token_calls, before)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        self.assertIn('auth_error=ok', _header(pairs, 'location'))

    def test_replay_does_not_exchange_again(self):
        location, jar, _attrs, _body = self._start('google', '/')
        callback = self._authorize(location)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        calls = self.idp.token_calls
        status, _pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 200, body)
        self.assertIn(b'Sign-in could not be confirmed', body)
        self.assertEqual(self.idp.token_calls, calls)

    def test_pkce_failure_is_a_sentence(self):
        location, jar, _attrs, _body = self._start('google', '/')
        callback = self._authorize(location)
        self.idp.mode = 'pkce'
        self.logs.clear()
        status, _pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 200)
        self.assertIn(b'Sign-in could not be completed. Your work is still on this device.', body)
        self.assertTrue(any('reason=pkce' in line for line in self.logs))
        last = json.loads(self._req('GET', self.idp.origin + '/control/last')[2])
        self.assertTrue(last['token']['secret_ok'])

    def test_bad_google_tokens_log_a_reason_code(self):
        for mode, reason in (('badsig', 'signature'), ('badaud', 'aud'), ('badnonce', 'nonce'), ('badexp', 'exp')):
            with self.subTest(mode=mode):
                location, jar, _attrs, _body = self._start('google', '/')
                callback = self._authorize(location)
                self.idp.mode = mode
                self.logs.clear()
                status, _pairs, body = self._callback(callback, jar)
                self.assertEqual(status, 200)
                self.assertIn(b'Sign-in could not be completed. Your work is still on this device.', body)
                self.assertTrue(any('reason=%s' % reason in line for line in self.logs), self.logs)
                self.idp.mode = 'ok'

    def test_open_redirects_are_rejected(self):
        for nxt in ('//evil.example', 'https://evil.example', '/\\evil', '/%2F%2Fevil', '/%5Cevil'):
            with self.subTest(nxt=nxt):
                status, pairs, body = self._req('GET', '/auth/google?next=' + urllib.parse.quote(nxt, safe=''))
                self.assertEqual(status, 400, body)
                self.assertIsNone(_header(pairs, 'location'))
                self.assertNotIn(b'evil', body.lower())

    def test_bad_code_does_not_call_the_provider(self):
        location, jar, _attrs, _body = self._start('google', '/')
        callback = self._authorize(location)
        parsed = urllib.parse.urlsplit(callback)
        params = urllib.parse.parse_qs(parsed.query)
        state = params['state'][0]
        calls = self.idp.token_calls
        for code in ('', 'bad code', 'a' * 513, '***'):
            url = urllib.parse.urlunsplit((
                parsed.scheme, parsed.netloc, parsed.path,
                urllib.parse.urlencode({'code': code, 'state': state}), '',
            ))
            status, _pairs, body = self._callback(url, jar)
            self.assertEqual(status, 200, body)
            self.assertEqual(self.idp.token_calls, calls)

    def test_logout_deletes_the_session_and_a_bad_csrf_does_not(self):
        jar, _old, _landed, _body = self._finish('google', '/')
        view, _pairs = self._session(jar)
        status, pairs, body = self._req(
            'POST', '/auth/logout',
            headers={'Cookie': self._jar_header(jar), 'Content-Type': 'application/json'},
            body=json.dumps({'csrf': 'nope'}).encode(),
        )
        self.assertEqual(status, 403, body)
        still, _ = self._session(jar)
        self.assertTrue(still['signed_in'])
        status, pairs, body = self._req(
            'POST', '/auth/logout',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            },
            body=json.dumps({'csrf': view['csrf']}).encode(),
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body), {'ok': True})
        cleared = _header(pairs, 'set-cookie').lower()
        self.assertIn('max-age=0', cleared)
        gone, _ = self._session(jar)
        self.assertFalse(gone['signed_in'])

    def test_import_is_idempotent_and_keeps_a_changed_body(self):
        jar, _old, _landed, _body = self._finish('github', '/')
        view, _pairs = self._session(jar)

        def item(pid, marker):
            return {'id': pid, 'name': 'Lamp', 'updated': 1, 'proj': {'id': pid, 'name': 'Lamp', 'parts': [marker], 'wires': []}}

        payload = {'csrf': view['csrf'], 'projects': [item('lamp%d' % n, 'a') for n in (1, 2, 3)]}
        status, _pairs, body = self._req(
            'POST', '/auth/projects/import',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            },
            body=json.dumps(payload).encode(),
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)['imported'], 3)
        status, _pairs, body = self._req(
            'POST', '/auth/projects/import',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            },
            body=json.dumps(payload).encode(),
        )
        self.assertEqual(json.loads(body)['imported'], 0)
        changed = {'csrf': view['csrf'], 'projects': [item('lamp1', 'b')]}
        status, _pairs, body = self._req(
            'POST', '/auth/projects/import',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            },
            body=json.dumps(changed).encode(),
        )
        self.assertEqual(json.loads(body)['imported'], 1)
        status, _pairs, body = self._req('GET', '/auth/projects', headers={'Cookie': self._jar_header(jar)})
        ids = {row['id'] for row in json.loads(body)['projects']}
        self.assertIn('lamp1', ids)
        self.assertTrue(any(item.startswith('lamp1-') for item in ids))

    def test_import_never_changes_another_users_project(self):
        self.idp.github_id = 4242
        try:
            jar_a, _old, _landed, _body = self._finish('github', '/')
            view_a, _pairs = self._session(jar_a)

            def item(pid, name, marker):
                return {'id': pid, 'name': name, 'updated': 1, 'proj': {'id': pid, 'name': name, 'parts': [marker], 'wires': []}}

            def post(jar, view, projects):
                return self._req(
                    'POST', '/auth/projects/import',
                    headers={
                        'Cookie': self._jar_header(jar),
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': view['csrf'],
                    },
                    body=json.dumps({'csrf': view['csrf'], 'projects': projects}).encode(),
                )

            def user_id(github_id):
                conn = sqlite3.connect(self.db)
                found = conn.execute(
                    'SELECT id FROM users WHERE provider = ? AND provider_user_id = ?',
                    ('github', str(github_id)),
                ).fetchone()
                conn.close()
                self.assertIsNotNone(found)
                return found[0]

            def owned(uid, pid):
                conn = sqlite3.connect(self.db)
                found = conn.execute(
                    'SELECT name, body, body_hash, updated FROM owned_projects WHERE user_id = ? AND project_id = ?',
                    (uid, pid),
                ).fetchone()
                conn.close()
                return None if found is None else tuple(found)

            status, _pairs, body = post(jar_a, view_a, [item('lamp', 'Ada lamp', 'a-body')])
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['imported'], 1)
            user_a = user_id(4242)
            before = owned(user_a, 'lamp')
            self.assertIsNotNone(before)

            self.idp.github_id = 7777
            jar_b, _old, _landed, _body = self._finish('github', '/')
            view_b, _pairs = self._session(jar_b)
            status, _pairs, body = post(jar_b, view_b, [item('lamp', 'Grace lamp', 'b-body')])
            self.assertEqual(status, 200, body)
            self.assertEqual(owned(user_a, 'lamp'), before)
            status, _pairs, body = self._req('GET', '/auth/projects/lamp', headers={'Cookie': self._jar_header(jar_a)})
            self.assertEqual(status, 200, body)
            got = json.loads(body)
            self.assertEqual(got['name'], 'Ada lamp')
            self.assertEqual(got['proj']['parts'], ['a-body'])

            changed = item('lamp', 'Ada lamp', 'a-body-2')
            encoded = json.dumps(changed['proj'], separators=(',', ':'), sort_keys=True)
            digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
            status, _pairs, body = post(jar_a, view_a, [changed])
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['imported'], 1)
            self.assertEqual(owned(user_a, 'lamp'), before)
            copy_id = ('lamp-' + digest[:8])[:40]
            copied = owned(user_a, copy_id)
            self.assertIsNotNone(copied)
            self.assertNotEqual(copy_id, 'lamp')
            self.assertEqual(copied[1], encoded)
            status, _pairs, body = self._req('GET', '/auth/projects/lamp', headers={'Cookie': self._jar_header(jar_a)})
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['proj']['parts'], ['a-body'])
        finally:
            self.idp.github_id = 4242

    def test_host_header_does_not_change_the_callback(self):
        status, pairs, body = self._req(
            'GET', '/auth/google?next=/',
            headers={'Host': 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https'},
        )
        self.assertEqual(status, 302, body)
        params = self._query(_header(pairs, 'location'))
        self.assertEqual(params['redirect_uri'], ['http://127.0.0.1:%d/auth/google/callback' % self.port])
        self.assertNotIn(b'evil.example', body)

    def test_staging_callback_and_cookie_path(self):
        base = 'http://127.0.0.1:%d/staging' % self.port
        self._enable(AUTH_BASE_URL=base)
        location, _jar, attrs, _body = self._start('github', '/')
        params = self._query(location)
        self.assertEqual(params['redirect_uri'], [base + '/auth/github/callback'])
        self.assertEqual(attrs.get('path'), '/staging')

    def test_staging_auth_links_keep_the_mount(self):
        base = 'http://127.0.0.1:%d/staging' % self.port
        self._enable(AUTH_BASE_URL=base)
        href = auth._again('google', '/staging/?ex=blink')
        self.assertTrue(href.startswith('/staging/auth/google?'), href)
        self.assertNotIn('://', href.split('?', 1)[0])
        page = auth._page(
            'The sign-in service did not respond. Your work is still on this device.',
            link_href=href,
        )
        text = page.body.decode('utf-8')
        self.assertIn('The sign-in service did not respond', text)
        self.assertIn('href="/staging/auth/google?', text)
        self.assertNotIn('href="/auth/', text)
        for provider in ('google', 'github'):
            link = auth._again(provider, '/staging/')
            self.assertTrue(link.startswith('/staging/auth/' + provider), link)
        landed = auth._with_flag('/staging/?ex=blink', 'ok')
        self.assertTrue(landed.startswith('/staging/'), landed)
        self.assertIn('auth_error=ok', landed)
        self.assertNotIn('/staging/staging', landed)
        home = auth._with_flag('/', 'cancelled')
        self.assertTrue(home.startswith('/staging/'), home)
        self.assertIn('auth_error=cancelled', home)
        back = auth.public_href('/')
        self.assertEqual(back, '/staging/')

    def test_test_idp_is_refused_off_loopback(self):
        self.logs.clear()
        auth.apply_env(self._config(
            AUTH_BASE_URL='https://esp32lab.duckdns.org',
            AUTH_TEST_IDP=self.idp.origin,
        ))
        self.assertEqual(auth.TEST_IDP, '')
        self.assertTrue(any('live host' in line for line in self.logs))
        self.logs.clear()
        auth.apply_env(self._config(
            AUTH_BASE_URL='https://esp32lab.duckdns.org/staging',
            AUTH_TEST_IDP=self.idp.origin,
        ))
        self.assertEqual(auth.TEST_IDP, '')
        auth.apply_env(self._config(AUTH_TEST_IDP='https://evil.example/google'))
        self.assertEqual(auth.TEST_IDP, '')
        self.assertTrue(any('not a loopback origin' in line for line in self.logs))
        auth.apply_env(self._config(AUTH_BASE_URL='https://example.com', AUTH_TEST_IDP=self.idp.origin))
        self.assertEqual(auth.TEST_IDP, '')

    def test_rate_limit_uses_the_trusted_proxy_only(self):
        https.apply_env({'TRUSTED_PROXY_IPS': '127.0.0.1'})
        self._enable(AUTH_RATE_MAX='2')
        for _ in range(2):
            status, _pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.10'})
            self.assertEqual(status, 200, body)
        status, pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.10'})
        self.assertEqual(status, 429, body)
        self.assertIn('Too many account requests', body.decode('utf-8'))
        self.assertTrue(_header(pairs, 'retry-after'))
        status, _pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.11'})
        self.assertEqual(status, 200, body)
        https.apply_env({'TRUSTED_PROXY_IPS': '172.30.0.250'})
        self._enable(AUTH_RATE_MAX='2')
        self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.21'})
        self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.22'})
        status, _pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.23'})
        self.assertEqual(status, 429, body)

    def test_forwarded_headers_need_an_exact_trusted_ip(self):
        spoof = {
            'X-Forwarded-For': '203.0.113.50',
            'X-Forwarded-Proto': 'https',
        }
        for label, proxies in (('empty', ''), ('cidr', '172.30.0.0/24'), ('wild', '*'), ('other', '172.30.0.250')):
            https.apply_env({'TRUSTED_PROXY_IPS': proxies})
            if label == 'other':
                self.assertEqual(https.PROXY_IPS, frozenset({'172.30.0.250'}))
            else:
                self.assertEqual(https.PROXY_IPS, frozenset(), label)
            self._enable(AUTH_RATE_MAX='1')
            first = self._req('GET', '/auth/google?next=/', headers=spoof)
            self.assertEqual(first[0], 302, (label, first[2][:80]))
            _name, _value, flags, _attrs = self._cookie(first[1])
            self.assertNotIn('secure', flags, label)
            again = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.51'})
            self.assertEqual(again[0], 429, label)
        https.apply_env({'TRUSTED_PROXY_IPS': '127.0.0.1, 172.30.0.250'})
        self._enable(AUTH_RATE_MAX='1')
        secured = self._req('GET', '/auth/google?next=/', headers={
            'X-Forwarded-For': '203.0.113.60, 172.30.0.250',
            'X-Forwarded-Proto': 'https',
        })
        self.assertEqual(secured[0], 302, secured[2][:80])
        _name, _value, flags, _attrs = self._cookie(secured[1])
        self.assertIn('secure', flags)
        blocked = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.60'})
        self.assertEqual(blocked[0], 429)
        other = self._req('GET', '/auth/session', headers={
            'X-Forwarded-For': '203.0.113.61, 172.30.0.250',
        })
        self.assertEqual(other[0], 200, other[2][:80])
        plain = self._req('GET', '/auth/github?next=/', headers={
            'X-Forwarded-For': '203.0.113.62',
            'X-Forwarded-Proto': 'http',
        })
        self.assertEqual(plain[0], 302, plain[2][:80])
        _name, _value, flags, _attrs = self._cookie(plain[1])
        self.assertNotIn('secure', flags)

    def test_account_db_resolves_inside_the_projects_directory(self):
        self.assertEqual(
            Path(auth.account_db_path(os.environ)).resolve(),
            (Path(server.PROJ_DIR) / 'accounts' / 'auth.sqlite').resolve(),
        )
        root = Path(self.tmp) / 'volume' / 'projects'
        outside = Path(self.tmp) / 'not-on-the-volume.sqlite'
        auth.apply_env(self._config(SIM_PROJECT_DIR=str(root), AUTH_DB=''))
        db = Path(auth.DB_PATH).resolve()
        projects = root.resolve()
        self.assertEqual(db, (projects / 'accounts' / 'auth.sqlite').resolve())
        db.relative_to(projects)
        self.assertNotEqual(db, projects)
        status, _pairs, body = self._req('GET', '/auth/session')
        self.assertEqual(status, 200, body)
        self.assertEqual(stat.S_IMODE(db.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(db.stat().st_mode), 0o600)
        for suffix in ('-wal', '-shm'):
            side = Path(str(db) + suffix)
            if side.exists():
                self.assertEqual(stat.S_IMODE(side.stat().st_mode), 0o600)
        auth.apply_env(self._config(SIM_PROJECT_DIR=str(root), AUTH_DB=str(outside)))
        self.assertEqual(Path(auth.DB_PATH).resolve(), db)
        self.assertFalse(outside.exists())
        self.assertTrue(any('projects directory' in line for line in self.logs))

    def test_flag_off_matches_an_unknown_path_and_skips_the_database(self):
        fresh = os.path.join(self.proj, 'accounts', 'absent.sqlite')
        auth.apply_env(self._config(AUTH_ENABLED='0', AUTH_DB=fresh))
        on = self._req('GET', '/auth/google')
        unk = self._req('GET', '/no-such-auth-page')
        self.assertEqual(on[0], unk[0])
        self.assertEqual(on[2], unk[2])
        self.assertIsNone(_header(on[1], 'set-cookie'))
        post_on = self._req('POST', '/auth/logout', body=b'{}')
        self.assertEqual(post_on[0], 404)
        self.assertEqual(post_on[2], unk[2])
        self.assertIsNone(_header(post_on[1], 'set-cookie'))
        status, _pairs, body = self._req('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertFalse(any('auth' in key for key in json.loads(body)))
        self.assertFalse(os.path.exists(fresh))
        for secret in (GOOGLE_SECRET, GITHUB_SECRET):
            self.assertNotIn(secret.encode(), on[2])
            self.assertNotIn(secret, '\n'.join(self.logs))

    def test_env_file_does_not_log_or_override(self):
        path = os.path.join(self.tmp, 'oauth.env')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('# comment\nNOT_A_KEY=%s\nGOOGLE_CLIENT_SECRET=%s\n' % (GOOGLE_SECRET, GOOGLE_SECRET))
        os.chmod(path, 0o600)
        os.environ.pop('GOOGLE_CLIENT_SECRET', None)
        self.logs.clear()
        auth.load_env_file(path)
        self.assertEqual(os.environ.get('GOOGLE_CLIENT_SECRET'), GOOGLE_SECRET)
        self.assertTrue(all(GOOGLE_SECRET not in line for line in self.logs))
        os.environ['GOOGLE_CLIENT_SECRET'] = 'already-set'
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('GOOGLE_CLIENT_SECRET=%s\n' % GOOGLE_SECRET)
        os.chmod(path, 0o666)
        self.logs.clear()
        auth.load_env_file(path)
        self.assertEqual(os.environ.get('GOOGLE_CLIENT_SECRET'), 'already-set')
        self.assertTrue(any('mode allows' in line for line in self.logs))
        self.assertTrue(all(GOOGLE_SECRET not in line for line in self.logs))
        os.environ.pop('GOOGLE_CLIENT_SECRET', None)

    def test_safe_next_rejects_off_origin_targets(self):
        self.assertIsNone(auth.safe_next('//evil'))
        self.assertIsNone(auth.safe_next('https://evil'))
        self.assertIsNone(auth.safe_next('/\\evil'))
        self.assertEqual(auth.safe_next('/lab?p=1'), '/lab?p=1')

    def test_state_is_single_use_and_bound_to_pkce(self):
        before = self.idp.token_calls
        location, jar, _attrs, _body = self._start('google', '/?p=lamp1')
        params = self._query(location)
        self.assertEqual(params.get('code_challenge_method'), ['S256'])
        with sqlite3.connect(self.db) as conn:
            pending = json.loads(conn.execute(
                'SELECT pending FROM sessions WHERE id = ?', (jar['cl_session'],)
            ).fetchone()[0])
        self.assertEqual(params['state'], [pending['state']])
        self.assertEqual(params['code_challenge'], [auth._challenge(pending['verifier'])])
        digest = hashlib.sha256(pending['verifier'].encode('ascii')).digest()
        self.assertEqual(params['code_challenge'][0], auth._b64url(digest))
        callback = self._authorize(location)
        parsed = urllib.parse.urlsplit(callback)
        query = urllib.parse.parse_qs(parsed.query)
        code = query['code'][0]
        missing = urllib.parse.urlunsplit((
            parsed.scheme, parsed.netloc, parsed.path,
            urllib.parse.urlencode({'code': code}), '',
        ))
        status, pairs, body = self._callback(missing, jar)
        self.assertEqual(status, 200, body)
        self.assertIn(b'Sign-in could not be confirmed', body)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertEqual(self.idp.token_calls, before)
        bad = pending['state'][:-1] + ('A' if pending['state'][-1] != 'A' else 'B')
        wrong = urllib.parse.urlunsplit((
            parsed.scheme, parsed.netloc, parsed.path,
            urllib.parse.urlencode({'code': code, 'state': bad}), '',
        ))
        status, pairs, body = self._callback(wrong, jar)
        self.assertEqual(status, 200, body)
        self.assertIn(b'Sign-in could not be confirmed', body)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertEqual(self.idp.token_calls, before)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        self.assertTrue(_header(pairs, 'location').startswith('/'))
        calls = self.idp.token_calls
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 200, body)
        self.assertIn(b'Sign-in could not be confirmed', body)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertEqual(self.idp.token_calls, calls)

    def test_open_redirect_blocks_evil_com_and_encoded_forms(self):
        blocked = (
            '//evil.com',
            'https://evil.com',
            'http://evil.com',
            'https://evil.com/path',
            '//evil.com/%2e%2e',
            '/\\evil.com',
            '/\\/evil.com',
            '///evil.com',
            '/%2F%2Fevil.com',
            '/%2f%2fevil.com',
            '/%5Cevil.com',
            '/%5c%5cevil.com',
            '/%252F%252Fevil.com',
            'https%3A%2F%2Fevil.com',
            'http%3A%2F%2Fevil.com%2F',
            '//evil.com%00.example',
        )
        for nxt in blocked:
            with self.subTest(nxt=nxt):
                status, pairs, body = self._req(
                    'GET', '/auth/google?next=' + urllib.parse.quote(nxt, safe=''),
                )
                self.assertEqual(status, 400, body)
                self.assertIsNone(_header(pairs, 'location'))
                self.assertNotIn(b'evil.com', body.lower())
                self.assertIsNone(_header(pairs, 'set-cookie'))
        status, pairs, body = self._req('GET', '/auth/github?next=' + urllib.parse.quote('/lab?p=1', safe=''))
        self.assertEqual(status, 302, body)
        self.assertNotIn('evil.com', _header(pairs, 'location'))

    def test_session_cookie_is_rotated_and_logout_kills_it(self):
        location, jar, attrs, _body = self._start('github', '/')
        self.assertEqual(attrs.get('samesite'), 'lax')
        callback = self._authorize(location)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        name, value, flags, attrs = self._cookie(pairs)
        self.assertEqual(name, 'cl_session')
        self.assertNotEqual(value, jar['cl_session'])
        self.assertIn('httponly', flags)
        self.assertNotIn('secure', flags)
        self.assertEqual(attrs.get('samesite'), 'lax')
        self.assertNotIn('domain', attrs)
        landed = _header(pairs, 'location')
        self.assertTrue(landed.startswith('/'))
        self.assertNotIn('://', landed)
        old = jar['cl_session']
        jar = {name: value}
        signed, _ = self._session(jar)
        self.assertTrue(signed['signed_in'])
        stale, _ = self._session({'cl_session': old})
        self.assertFalse(stale['signed_in'])
        status, pairs, body = self._req(
            'POST', '/auth/logout',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'Origin': 'http://127.0.0.1:%d' % self.port,
                'X-CSRF-Token': signed['csrf'],
            },
            body=json.dumps({'csrf': signed['csrf']}).encode(),
        )
        self.assertEqual(status, 200, body)
        cleared = _header(pairs, 'set-cookie').lower()
        self.assertIn('httponly', cleared)
        self.assertNotIn('secure', cleared)
        self.assertIn('samesite=lax', cleared)
        gone, _ = self._session(jar)
        self.assertFalse(gone['signed_in'])
        self.assertFalse(self._session({'cl_session': old})[0]['signed_in'])

    def test_cross_site_post_is_rejected(self):
        jar, _old, _landed, _body = self._finish('google', '/')
        view, _ = self._session(jar)
        for origin, referer in (
            ('https://evil.com', None),
            (None, 'https://evil.com/steal'),
            ('null', None),
        ):
            headers = {
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            }
            if origin:
                headers['Origin'] = origin
            if referer:
                headers['Referer'] = referer
            status, _pairs, body = self._req(
                'POST', '/auth/logout', headers=headers,
                body=json.dumps({'csrf': view['csrf']}).encode(),
            )
            self.assertEqual(status, 403, (origin, referer, body))
            self.assertEqual(json.loads(body).get('error'), 'csrf')
            status, _pairs, body = self._req(
                'POST', '/auth/projects/import', headers=headers,
                body=json.dumps({'csrf': view['csrf'], 'projects': []}).encode(),
            )
            self.assertEqual(status, 403, (origin, referer, body))
        still, _ = self._session(jar)
        self.assertTrue(still['signed_in'])

    def test_login_and_callback_return_429(self):
        self._enable(AUTH_RATE_MAX='2')
        for _ in range(2):
            status, _pairs, body = self._req('GET', '/auth/google?next=/')
            self.assertEqual(status, 302, body)
        status, pairs, body = self._req('GET', '/auth/google?next=/')
        self.assertEqual(status, 429, body)
        self.assertIn('Too many sign-in attempts', body.decode('utf-8'))
        self.assertTrue(_header(pairs, 'retry-after'))
        self._enable(AUTH_RATE_MAX='2')
        location, jar, _attrs, _body = self._start('github', '/')
        callback = self._authorize(location)
        status, _pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        status, pairs, body = self._req('GET', '/auth/github/callback?code=abc&state=abc')
        self.assertEqual(status, 429, body)
        self.assertTrue(_header(pairs, 'retry-after'))

    def test_full_login_and_logout_logs_omit_codes_tokens_and_email(self):
        self.logs.clear()
        location, jar, _attrs, _body = self._start('google', '/?view=schematic')
        callback = self._authorize(location)
        code = self._query(callback)['code'][0]
        self.assertTrue(code)
        status, pairs, body = self._callback(callback, jar)
        self.assertEqual(status, 302, body)
        landed = _header(pairs, 'location')
        name, value, _flags, _attrs = self._cookie(pairs)
        jar = {name: value}
        view, _ = self._session(jar)
        status, pairs, out_body = self._req(
            'POST', '/auth/logout',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': view['csrf'],
            },
            body=json.dumps({'csrf': view['csrf']}).encode(),
        )
        self.assertEqual(status, 200, out_body)
        text = '\n'.join(self.logs)
        surfaces = text + '\n' + (landed or '') + '\n' + body.decode('utf-8', 'replace') + '\n' + out_body.decode('utf-8', 'replace')
        for secret in (code, ACCESS_TOKEN, REFRESH, GOOGLE_SECRET, GITHUB_SECRET, 'ada@example.com'):
            self.assertNotIn(secret, surfaces)
            self.assertNotIn(secret, location)

    def test_flag_off_hides_every_auth_route(self):
        self._enable(AUTH_ENABLED='0')
        routes = (
            ('GET', '/auth'),
            ('GET', '/auth/'),
            ('GET', '/auth/session'),
            ('GET', '/auth/google'),
            ('GET', '/auth/github'),
            ('GET', '/auth/google/callback'),
            ('GET', '/auth/github/callback?code=abc&state=abc'),
            ('GET', '/auth/projects'),
            ('GET', '/auth/projects/lamp1'),
            ('POST', '/auth/logout'),
            ('POST', '/auth/projects/import'),
            ('POST', '/auth/google'),
            ('POST', '/auth/github/callback'),
        )
        missing = self._req('GET', '/no-such-auth-page')
        self.assertEqual(missing[0], 404)
        for method, path in routes:
            with self.subTest(method=method, path=path):
                body = b'{}' if method == 'POST' else None
                got = self._req(method, path, body=body)
                self.assertEqual(got[0], 404, (method, path, got[0], got[2][:80]))
                self.assertEqual(got[2], missing[2])
                self.assertIsNone(_header(got[1], 'set-cookie'))
                self.assertIsNone(_header(got[1], 'location'))

    def test_flag_off_page_does_not_offer_an_auth_status_check(self):
        page = (Path(__file__).resolve().parents[1] / 'index.html').read_bytes()
        self.assertNotIn(b'name="cl-auth"', page)
        self._enable(AUTH_ENABLED='0')
        off = self._req('GET', '/')
        self.assertEqual(off[0], 200)
        self.assertEqual(off[2], page)
        self.assertNotIn(b'name="cl-auth"', off[2])
        self._enable()
        on = self._req('GET', '/')
        self.assertEqual(on[0], 200)
        self.assertIn(b'<meta name="cl-auth" content="1">', on[2])
        self.assertNotEqual(on[2], page)

    def test_restored_account_database_keeps_the_session(self):
        jar, _old, _landed, _body = self._finish('google', '/')
        view, _ = self._session(jar)
        self.assertTrue(view['signed_in'])
        backup = os.path.join(self.proj, 'accounts', 'auth.sqlite.bak')
        source = sqlite3.connect(self.db)
        try:
            dest = sqlite3.connect(backup)
            try:
                source.backup(dest)
            finally:
                dest.close()
        finally:
            source.close()
        self._enable()
        for suffix in ('', '-wal', '-shm', '-journal'):
            path = self.db + suffix
            if os.path.exists(path):
                os.remove(path)
        shutil.copy(backup, self.db)
        os.chmod(self.db, 0o600)
        self._enable()
        restored, _ = self._session(jar)
        self.assertTrue(restored['signed_in'])
        self.assertEqual(restored['display_name'], view['display_name'])
        self.assertEqual(restored['provider'], 'google')
        status, _pairs, body = self._req(
            'POST', '/auth/logout',
            headers={
                'Cookie': self._jar_header(jar),
                'Content-Type': 'application/json',
                'X-CSRF-Token': restored['csrf'],
            },
            body=json.dumps({'csrf': restored['csrf']}).encode(),
        )
        self.assertEqual(status, 200, body)
        self.assertFalse(self._session(jar)[0]['signed_in'])

    def test_account_projects_stay_with_their_user(self):
        jar, _old, _landed, _body = self._finish('github', '/')
        view, _pairs = self._session(jar)
        item = {
            'id': 'desk', 'name': 'Desk lamp',
            'proj': {'id': 'desk', 'name': 'Desk lamp', 'parts': [{'id': 'r1'}], 'wires': []},
        }
        headers = {
            'Cookie': self._jar_header(jar),
            'Content-Type': 'application/json',
            'X-CSRF-Token': view['csrf'],
        }
        status, _pairs, body = self._req(
            'POST', '/auth/projects/import', headers=headers,
            body=json.dumps({'csrf': view['csrf'], 'projects': [item]}).encode(),
        )
        self.assertEqual(status, 200, body)
        status, _pairs, body = self._req('GET', '/auth/projects', headers={'Cookie': self._jar_header(jar)})
        self.assertEqual(status, 200, body)
        rows = json.loads(body)['projects']
        self.assertEqual([row['name'] for row in rows], ['Desk lamp'])
        self.assertIn('updated', rows[0])
        status, _pairs, body = self._req('GET', '/auth/projects/desk', headers={'Cookie': self._jar_header(jar)})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)['proj']['parts'], [{'id': 'r1'}])
        status, _pairs, body = self._req('GET', '/auth/projects')
        self.assertEqual(status, 401, body)
        self.assertIn('Sign in', body.decode('utf-8'))
        status, _pairs, body = self._req('GET', '/auth/projects/desk')
        self.assertEqual(status, 401, body)
        self.idp.github_id = 999001
        try:
            other, _old, _landed, _body = self._finish('github', '/')
            status, _pairs, body = self._req('GET', '/auth/projects', headers={'Cookie': self._jar_header(other)})
            self.assertEqual(status, 200, body)
            self.assertEqual(json.loads(body)['projects'], [])
            status, _pairs, body = self._req('GET', '/auth/projects/desk', headers={'Cookie': self._jar_header(other)})
            self.assertEqual(status, 404, body)
            self.assertNotIn(b'Desk lamp', body)
        finally:
            self.idp.github_id = 4242

    def test_rate_limit_log_uses_a_prefix(self):
        self.assertEqual(https.network_label('203.0.113.10'), '203.0.113.0/24')
        self.assertEqual(https.network_label('203.0.113.255'), '203.0.113.0/24')
        self.assertEqual(https.network_label('2001:db8:abcd:1234::5'), '2001:db8:abcd::/48')
        self.assertNotIn('203.0.113.10', https.network_label('203.0.113.10'))
        self.assertNotIn('1234', https.network_label('2001:db8:abcd:1234::5'))
        notes = []
        https.set_logger(lambda msg: notes.append(str(msg)))
        try:
            https.apply_env({'TRUSTED_PROXY_IPS': '172.30.0.0/24'})
            self.assertEqual(notes, ['warning TRUSTED_PROXY_IPS ignored: a value is not an exact IP'])
            self.assertNotIn('172.30.0.0', notes[0])
            self.assertEqual(https.PROXY_IPS, frozenset())
            notes.clear()
            https.apply_env({'TRUSTED_PROXY_IPS': 'not-an-ip'})
            self.assertEqual(notes, ['warning TRUSTED_PROXY_IPS ignored: a value is not an exact IP'])
            self.assertNotIn('not-an-ip', notes[0])
            notes.clear()
            https.apply_env({'TRUSTED_PROXY_IPS': '127.0.0.1'})
            self.assertEqual(notes, [])
            self._enable(AUTH_RATE_MAX='1')
            self.logs.clear()
            self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.10'})
            status, _pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '203.0.113.10'})
            self.assertEqual(status, 429, body)
            lines = [line for line in self.logs if line.startswith('auth rate_limit')]
            self.assertEqual(lines, ['auth rate_limit status=429 client=203.0.113.0/24 source=forwarded'])
            joined = '\n'.join(self.logs)
            self.assertNotIn('203.0.113.10', joined)
            self.assertNotIn('@', joined)
            https.apply_env({'TRUSTED_PROXY_IPS': ''})
            self._enable(AUTH_RATE_MAX='1')
            self.logs.clear()
            self._req('GET', '/auth/session', headers={'X-Forwarded-For': '198.51.100.20'})
            status, _pairs, body = self._req('GET', '/auth/session', headers={'X-Forwarded-For': '198.51.100.20'})
            self.assertEqual(status, 429, body)
            peer = [line for line in self.logs if line.startswith('auth rate_limit')]
            self.assertEqual(peer, ['auth rate_limit status=429 client=127.0.0.0/24 source=peer'])
            self.assertNotIn('127.0.0.1', '\n'.join(self.logs))
            self.assertNotIn('198.51.100', '\n'.join(self.logs))
        finally:
            https.set_logger(lambda msg: None)
            https.apply_env({})
            self._enable()


if __name__ == '__main__':
    unittest.main()
