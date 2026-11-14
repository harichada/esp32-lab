# HTTPS

Caddy is the TLS terminator. The container is `circuitlab-caddy`. It listens on 443, obtains the Let's Encrypt certificate for `esp32lab.duckdns.org` with TLS-ALPN-01, and reverse-proxies to the app at `esp32lab:8765` on the shared Docker network. Port 80 is published to the app (`-p 80:8765`) and does not go through Caddy. This process does not issue a certificate, does not listen on 443, and does not reload a certificate.

The app container publishes port 80 only. Do not publish 8765.

## Reference Caddyfile

The file on the server is `/home/opc/caddy/Caddyfile`. That copy is authoritative. This block is the reference built from the settings that are known: the domain, `auto_https disable_redirects`, the HTTP challenge disabled so issuance is TLS-ALPN only, and `reverse_proxy esp32lab:8765`. It is not a claim that the server file is byte-for-byte this text.

```
{
	auto_https disable_redirects
}

esp32lab.duckdns.org {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	reverse_proxy esp32lab:8765 {
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

`auto_https disable_redirects` keeps Caddy from answering port 80. Port 80 belongs to the app, which is what serves `/api/health` and, while the redirect flag is off, the site itself. The HTTP challenge is off because Caddy is not the process on port 80. Let's Encrypt uses TLS-ALPN-01 on 443.

Caddy replaces forwarding headers that the client sent. The app trusts `X-Forwarded-Proto` and `X-Forwarded-Host` for that reason, and only when the TCP peer is the pinned proxy address. A header the client sent to the app directly is not Caddy's header.

## Caddy on the host

Pin the container to `172.18.0.250`. The network is the Docker network where the app is reachable as `esp32lab` and where staging also runs. The data volume is the one already mounted at `/data` on `circuitlab-caddy`. Keep that volume. Deleting it throws away the account and the certificate, and a replacement issuance counts against Let's Encrypt's duplicate-certificate limit (five certificates for the same name per week).

```
docker run -d --name circuitlab-caddy --restart unless-stopped \
  --network <shared-network> --ip 172.18.0.250 \
  -p 443:443 \
  -v <caddy-data>:/data \
  -v /home/opc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2
```

`<shared-network>` and `<caddy-data>` are the ones `docker inspect circuitlab-caddy` already shows. Do not create a second data volume.

## Trusted proxy

`TRUSTED_PROXY_IPS` is a comma-separated list of exact IP addresses. The documented value is `172.18.0.250`, the address Caddy is pinned to with `--ip 172.18.0.250`.

The setting never accepts a CIDR range. A value that contains `/`, or any token that is not an IP address, is rejected at startup. The process logs `TRUSTED_PROXY_IPS rejected (...); trusting nobody` and trusts no peer.

Do not trust the Docker subnet. Staging runs on that same network, so another container can open a connection to the app. Only the pinned Caddy address is a proxy. `X-Forwarded-For` is never the thing that decides trust. The TCP peer is.

From a peer that is not in the list, including another address on the Docker network and including `127.0.0.1`, `X-Forwarded-Proto` and `X-Forwarded-For` are ignored. A malformed or repeated `X-Forwarded-Proto` or `X-Forwarded-Host` from the pinned address is 400. `X-Forwarded-Host` is adopted only when `ALLOWED_HOSTS` is set and the value is in that list. The redirect target is still only `https://HTTPS_HOST` plus the path and query.

## Flags

| Variable | Default | Meaning |
|---|---|---|
| `HTTPS_ENABLED` | `0` | Only the string `1` turns the redirect on. While it is off the app does not read forwarding headers, does not redirect, and does not add or remove a header. |
| `HTTPS_HOST` | empty | The only redirect target. Empty or invalid leaves the redirect off and logs that. Documented value: `esp32lab.duckdns.org`. The Host header is never copied into `Location`. |
| `TRUSTED_PROXY_IPS` | empty | Exact IPs. Empty trusts nobody. Documented value: `172.18.0.250`. |
| `HSTS_ENABLED` | `0` | Only the string `1` may send `Strict-Transport-Security`, and only on a request the trusted proxy confirmed as https. |
| `HSTS_SECONDS` | `0` | `max-age` once HSTS is on. No `includeSubDomains`, no `preload`. Above 63072000 is rejected and HSTS stays off. Later rollout: 300, then 86400, then 31536000. |
| `ALLOWED_HOSTS` | unset (accept every Host) | Comma-separated hosts. Any other Host is 400, including an absolute-form request target. |

`/api/health` stays on plain HTTP with no redirect. Its JSON does not grow a certificate object. `ok` is the qemu and arduino-cli check.

With `HTTPS_ENABLED=1`, a plain HTTP request (the peer is not the trusted proxy, or the trusted proxy says `http`) for an allowed host is 301 for GET and HEAD and 308 for every other method. The target is `https://HTTPS_HOST` plus the path and query. A top-level HTML GET (`/`, `/index.html`, other `.html`) is the project handoff page instead of a 301. A WebSocket on plain HTTP is 403 with the body `WebSocket over plain HTTP is refused while HTTPS redirect is on. Use wss://.`

A request the trusted proxy marks `https` is not redirected. The app treats that request as https, so the staging cookie is `Secure` and HSTS can be sent. The same is true for `/staging/...`: the redirect, when it happens, keeps the path and the query (`/staging/foo?x=1` stays `/staging/foo?x=1`). With `HTTPS_ENABLED=0`, `/staging/` is unchanged.

HSTS is not sent on plain HTTP. Confirmed-https responses also send `Content-Security-Policy: upgrade-insecure-requests`, appended when a policy is already there. The handoff page and `/migrate` do not. Their policy is `default-src 'none'` with the nonce those pages need.

## Project handoff

A browser that still has projects on the plain HTTP origin gets one page from this server. That page reads the saved keys and navigates to `https://HTTPS_HOST/migrate#…`, or, above about 1.5 MB and within 2 MB, posts the same record. The fragment is removed with `history.replaceState` before any other script runs. The HTTPS page merges without replacing a project that is already there. A different body for the same id is kept as “(moved copy)”. The HTTP copy is not deleted. `cl_migrated_to_https` is set on the HTTP origin only after the HTTPS page confirms. When HSTS is on, that confirmation skips the extra HTTP round trip. A POST larger than 2 MB is 413 and is not written to disk or to the log.

## Turning the redirect on

1. Caddy is already on 443 at `172.18.0.250`, and `https://esp32lab.duckdns.org/api/health` answers.
2. Set `TRUSTED_PROXY_IPS=172.18.0.250` and `HTTPS_HOST=esp32lab.duckdns.org`. Leave `HTTPS_ENABLED=0` and recreate the app container. Plain HTTP is unchanged. A client that sends `X-Forwarded-Proto: https` still gets the HTTP site.
3. Set `HTTPS_ENABLED=1` and recreate. An asset on port 80 is 301 to `https://esp32lab.duckdns.org` with the path and query kept. `GET /` on HTTP is the handoff page. `GET /api/health` on HTTP is 200 with no `Location`. `GET /staging/...` on HTTP redirects to the same path on `https://esp32lab.duckdns.org`.
4. Leave `HSTS_ENABLED=0` until the redirect has been checked. Then 300, then 86400, then 31536000. Each step is a recreate. A browser that stored HSTS does not forget it when the flag goes back to 0. A browser that stored a 301 does not forget it either.

Sign-in callback URLs for the later auth work are `https://esp32lab.duckdns.org/auth/callback/google` and `https://esp32lab.duckdns.org/auth/callback/github`.

## Renewal

Caddy renews the certificate by itself, about 30 days before it expires, and stores it in its data volume. Check:

```
docker logs circuitlab-caddy
openssl s_client -connect esp32lab.duckdns.org:443 -servername esp32lab.duckdns.org | openssl x509 -noout -dates
```

Do not delete the data volume. Do not loop issuance. Let's Encrypt allows five duplicate certificates for the same name per week, and the certificate Caddy already has counts.

## Rollback

Set `HTTPS_ENABLED=0` and recreate the app container. The redirect stops. Caddy keeps serving the certificate. `HSTS_ENABLED=0` stops new HSTS headers. It does not clear a `Strict-Transport-Security` value a browser already stored, and it does not clear a 301 a browser already stored.

To take HTTPS off the host, stop `circuitlab-caddy` and close 443. Keep the data volume. The app keeps publishing port 80 only.

Previous app images, if the app container itself has to be rolled back: v66 `e3d38a538a45` (tag `rollback-keep-v66`) with `/home/opc/backup-v66`, and v65 `356f7c19711d` with `/home/opc/backup-v65`.
