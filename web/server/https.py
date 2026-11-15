"""Exact-IP proxy trust for the sign-in cookie and the sign-in rate limit.

TRUSTED_PROXY_IPS is a comma-separated list of exact IP addresses. A slash,
a wildcard, or any token that is not an IP trusts nobody. Production uses
172.30.0.250. There is no HTTPS redirect and no project-move flow here.
"""
import ipaddress
import os
import threading

PROXY_IPS = frozenset()
_log = lambda msg: None


def set_logger(fn):
    global _log
    _log = fn or (lambda msg: None)


def apply_env(env=None):
    """Read TRUSTED_PROXY_IPS. Empty trusts nobody."""
    global PROXY_IPS
    env = os.environ if env is None else env
    PROXY_IPS = _parse_proxy_ips(env.get('TRUSTED_PROXY_IPS', ''))


def _parse_proxy_ips(raw):
    """Exact IP addresses. Anything else trusts nobody and logs one warning.

    The warning does not include the setting. A full address, a prefix, or a
    token that is not an IP must not land in the log.
    """
    text = str(raw or '').strip()
    if not text:
        return frozenset()
    found = []
    bad = '/' in text
    if not bad:
        for part in text.split(','):
            token = part.strip()
            if not token:
                bad = True
                break
            try:
                found.append(str(ipaddress.ip_address(token)))
            except ValueError:
                bad = True
                break
    if bad:
        _log('warning TRUSTED_PROXY_IPS ignored: a value is not an exact IP')
        return frozenset()
    return frozenset(found)


def network_label(ip):
    """The counted client as a prefix: IPv4 /24, IPv6 /48. Never the full address."""
    try:
        addr = ipaddress.ip_address(str(ip or '').strip())
    except ValueError:
        return 'unknown'
    bits = 24 if addr.version == 4 else 48
    net = ipaddress.ip_network((addr, bits), strict=False)
    return '%s/%d' % (net.network_address, bits)


def _peer_ip(scope):
    """The TCP peer, never a forwarding header. Empty when it is not an IP."""
    client = scope.get('client') or None
    if not client:
        return ''
    host = client[0]
    if isinstance(host, bytes):
        host = host.decode('ascii', 'replace')
    host = str(host or '').strip()
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return ''


def _forwarded_values(scope, name):
    found = []
    for key, value in scope.get('headers') or []:
        if key.lower() == name:
            try:
                text = value.decode('latin1')
            except AttributeError:
                text = str(value)
            found.append(text)
    return found


def client_view(scope):
    """(address, source) for the sign-in rate limit.

    source is 'peer' for the TCP peer and 'forwarded' when a trusted proxy's
    X-Forwarded-For supplied the counted address. A peer outside
    TRUSTED_PROXY_IPS cannot change the address with that header. A trusted
    peer may name the client as the rightmost address that is not itself a
    trusted proxy. A missing, repeated, or malformed header keeps the peer.
    """
    peer = _peer_ip(scope) or 'unknown'
    if peer not in PROXY_IPS:
        return peer, 'peer'
    values = _forwarded_values(scope, b'x-forwarded-for')
    if len(values) != 1:
        return peer, 'peer'
    text = values[0]
    if text != text.strip() or not text or any(c in text for c in '\t\r\n'):
        return peer, 'peer'
    parts = [part.strip() for part in text.split(',')]
    if not parts or any(not part for part in parts):
        return peer, 'peer'
    for part in reversed(parts):
        if part.startswith('[') and part.endswith(']'):
            part = part[1:-1]
        try:
            ip = str(ipaddress.ip_address(part))
        except ValueError:
            return peer, 'peer'
        if ip in PROXY_IPS:
            continue
        return ip, 'forwarded'
    return peer, 'peer'


def client_ip(scope):
    """Address for the sign-in rate limit. See client_view."""
    return client_view(scope)[0]


def rate_limit_log(scope):
    """One structured 429 line. The address is a prefix, never a full IP."""
    ip, source = client_view(scope)
    if source not in ('peer', 'forwarded'):
        source = 'peer'
    return 'auth rate_limit status=429 client=%s source=%s' % (network_label(ip), source)


def request_secure(scope):
    """Whether cl_session should be marked Secure.

    A direct https connection is Secure. X-Forwarded-Proto is honored only
    from a trusted peer, and only the value https sets Secure. A spoofed
    proto from any other peer is ignored.
    """
    scheme = (scope.get('scheme') or '').lower()
    if scheme in ('https', 'wss'):
        return True
    if _peer_ip(scope) not in PROXY_IPS:
        return False
    values = _forwarded_values(scope, b'x-forwarded-proto')
    if len(values) != 1:
        return False
    text = values[0]
    if text != text.strip() or not text or any(c in text for c in ', \t\r\n'):
        return False
    return text.lower() == 'https'


class Background:
    """One plain HTTP listener for tests. proxy_headers stays off."""

    def __init__(self, app, host='127.0.0.1', http_port=0, tls_port=0):
        self.app = app
        self.host = host
        self._http_port = http_port
        self.http_port = None
        self.server = None
        self.thread = None

    def start(self, timeout=15):
        import uvicorn
        config = uvicorn.Config(
            self.app, host=self.host, port=self._http_port, log_level='error',
            access_log=False, proxy_headers=False, forwarded_allow_ips='',
        )
        self.server = uvicorn.Server(config)
        self.server.install_signal_handlers = lambda: None
        self.thread = threading.Thread(target=self.server.run, name='auth-listener', daemon=True)
        self.thread.start()
        for _ in range(int(timeout * 20)):
            if self.server.started:
                break
            self.thread.join(0.05)
        if not self.server.started:
            self.stop()
            raise RuntimeError('listener did not start')
        self.http_port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    def stop(self):
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None:
            self.thread.join(3)
