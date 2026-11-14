# HTTPS

Caddy is the TLS terminator. The container is `circuitlab-caddy`. Live and Caddy sit on the internal network `circuitlab-prod` (`172.30.0.0/24`). Caddy is pinned at `172.30.0.250`. It listens on 443, obtains the Let's Encrypt certificate for `esp32lab.duckdns.org` with TLS-ALPN-01, and reverse-proxies the site to the app at `esp32lab:8765`. A request whose path is `/staging*` goes straight to `esp32lab-staging:8765` and does not enter the live app. Port 80 is published to the app (`-p 80:8765`) and does not go through Caddy. This process does not issue a certificate, does not listen on 443, and does not reload a certificate.

The app container publishes port 80 only. Do not publish 8765.

## Reference Caddyfile

The file on the server is `/home/opc/caddy/Caddyfile`. That copy is authoritative. This block is the reference built from the settings that are known: the domain, `auto_https disable_redirects`, the HTTP challenge disabled so issuance is TLS-ALPN only, `reverse_proxy esp32lab:8765`, and `/staging*` routed to `esp32lab-staging:8765`. It is not a claim that the server file is byte-for-byte this text.

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
	handle /staging* {
		reverse_proxy esp32lab-staging:8765
	}
	handle {
		reverse_proxy esp32lab:8765 {
			header_up Host {host}
			header_up X-Forwarded-Proto {scheme}
		}
	}
}
```

`auto_https disable_redirects` keeps Caddy from answering port 80. Port 80 belongs to the app, which is what serves `/api/health` and, while the redirect flag is off, the site itself. The HTTP challenge is off because Caddy is not the process on port 80. Let's Encrypt uses TLS-ALPN-01 on 443.

Caddy replaces forwarding headers that the client sent. The app trusts `X-Forwarded-Proto` and `X-Forwarded-Host` for that reason, and only when the TCP peer is the pinned proxy address. A header the client sent to the app directly is not Caddy's header.

## Caddy on the host

Pin the container to `172.30.0.250` on `circuitlab-prod`. Live moves to that same network. Staging stays the container Caddy reaches as `esp32lab-staging`. The data volume is the one already mounted at `/data` on `circuitlab-caddy`. Keep that volume. Deleting it throws away the account and the certificate, and a replacement issuance counts against Let's Encrypt's duplicate-certificate limit (five certificates for the same name per week).

```
docker run -d --name circuitlab-caddy --restart unless-stopped \
  --network circuitlab-prod --ip 172.30.0.250 \
  -p 443:443 \
  -v <caddy-data>:/data \
  -v /home/opc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2
```

`<caddy-data>` is the volume `docker inspect circuitlab-caddy` already shows. Do not create a second data volume.

## Trusted proxy

`TRUSTED_PROXY_IPS` is a comma-separated list of exact IP addresses. The documented value is `172.30.0.250`, the address Caddy is pinned to with `--ip 172.30.0.250` on `circuitlab-prod`.

The setting never accepts a CIDR range. A value that contains `/`, or any token that is not an IP address, is rejected at startup. The process logs `TRUSTED_PROXY_IPS rejected (...); trusting nobody` and trusts no peer. `172.30.0.0/24` is the Docker network, not a value for this setting.

Do not trust the Docker subnet. Another container on `circuitlab-prod` can open a connection to the app. Only the pinned Caddy address is a proxy. `X-Forwarded-For` is never the thing that decides trust. The TCP peer is.

From a peer that is not in the list, including `172.30.0.5` on the new network, `172.18.0.5` on the old one, and `127.0.0.1`, `X-Forwarded-Proto` and `X-Forwarded-For` are ignored. A malformed or repeated `X-Forwarded-Proto` or `X-Forwarded-Host` from the pinned address is 400. `X-Forwarded-Host` is adopted only when `ALLOWED_HOSTS` is set and the value is in that list. The redirect target is still only `https://HTTPS_HOST` plus the path and query.

## Flags

| Variable | Default | Meaning |
|---|---|---|
| `HTTPS_ENABLED` | `0` | Only the string `1` turns the redirect on. While it is off the app does not read forwarding headers, does not redirect, and does not add or remove a header. |
| `HTTPS_HOST` | empty | The only redirect target. Empty or invalid leaves the redirect off and logs that. Documented value: `esp32lab.duckdns.org`. The Host header is never copied into `Location`. |
| `TRUSTED_PROXY_IPS` | empty | Exact IPs. Empty trusts nobody. Documented value: `172.30.0.250`. |
| `STAGING_PROXY_ENABLED` | `0` | Only `1` turns on the app's `/staging` pass-through. Off, `/staging` and `/staging/*` are 502 and nothing is connected upstream. |
| `HSTS_ENABLED` | `0` | Only the string `1` may send `Strict-Transport-Security`, and only on a request the trusted proxy confirmed as https. |
| `HSTS_SECONDS` | `0` | `max-age` once HSTS is on. No `includeSubDomains`, no `preload`. Above 63072000 is rejected and HSTS stays off. Later rollout: 300, then 86400, then 31536000. |
| `ALLOWED_HOSTS` | unset (accept every Host) | Comma-separated hosts. Any other Host is 400, including an absolute-form request target. |

`/api/health` stays on plain HTTP with no redirect. Its JSON does not grow a certificate object. `ok` is the qemu and arduino-cli check.

With `HTTPS_ENABLED=1`, a plain HTTP request (the peer is not the trusted proxy, or the trusted proxy says `http`) for an allowed host is 301 for GET and HEAD and 308 for every other method. The target is `https://HTTPS_HOST` plus the path and query. A top-level HTML GET (`/`, `/index.html`, other `.html`) is the project handoff page instead of a 301. A WebSocket on plain HTTP is 403 with the body `WebSocket over plain HTTP is refused while HTTPS redirect is on. Use wss://.`

A request the trusted proxy marks `https` is not redirected. The app treats that request as https, so HSTS can be sent. Forwarded headers from any other address are ignored, including a spoofed `X-Forwarded-Proto`. When `SIM_STAGING=1`, the staging cookie is always `Secure`, `HttpOnly`, and `SameSite=Lax`, because that process is only reached over https through Caddy. The proto header does not add or remove `Secure`. With staging off, `Secure` follows the scheme left after untrusted forwarding headers are dropped. If the HTTPS redirect is on and the request is still plain HTTP, `/staging/foo?x=1` keeps that path and query on `https://HTTPS_HOST`. A request for the staging base without the trailing slash, such as `/staging?x=1`, is `301` to `/staging/?x=1` instead of `401`. Caddy then sends `/staging*` to the staging container. A conditional GET of a static file returns `304` with no body when `If-None-Match` or `If-Modified-Since` matches. `/api/` never returns `304`. A WebSocket resume (`?sid=&since=`) is accepted when the trusted proxy says https, and a spoofed proto on plain HTTP is still refused.

`STAGING_PROXY_ENABLED` defaults to `0`. A request that reaches the app at `/staging` or `/staging/*` is 502. The body says staging is only available at `https://esp32lab.duckdns.org/staging/`. It contains no container name, address, or token. `HEAD` is the same status with no body. No upstream connection is opened. That is what `http://<the public IP>/staging/` returns while this flag is off. `https://esp32lab.duckdns.org/staging/` does not hit this proxy. Set the flag to `1` and the app's pass-through is the previous one: empty upstream is 404, a configured upstream is forwarded.

HSTS is not sent on plain HTTP. Confirmed-https responses also send `Content-Security-Policy: upgrade-insecure-requests`, appended when a policy is already there. The handoff page and `/migrate` do not. Their policy is `default-src 'none'` with the nonce those pages need.

## Project handoff

A browser that still has saved projects on the plain HTTP origin gets one page from this server. That page posts the record to `https://HTTPS_HOST/migrate` inside a hidden frame. The record is the POST body only. It is not put in a URL, a query string, or a fragment. A stray fragment on the move page is discarded and is not read. The HTTPS page checks the record, merges it, and replies with the project count and the SHA-256 of the canonical JSON. The HTTP page sets `cl_migrate_attempt` only after that reply matches the count and the checksum it computed before sending. It then opens the secure site. The HTTP copy is never deleted.

`cl_migrate_attempt` is absent until a reply has been checked. An interrupted attempt leaves it absent, so the same tab can try again. A value left over from an earlier interrupted attempt does not skip the move. After a checked reply the flag holds the checksum. `cl_migrated_to_https` is set at the same moment, on the HTTP origin. A later visit that already has `cl_migrated_to_https` opens the secure site without sending the projects again.

Cancel stays on the original address (`?clstay=1`) and does not set either flag. The handoff page uses the lab's dark theme (and the light theme when `data-theme` is light).

Any failure stays on this server's failure page: a network error, a timeout, a 4xx or 5xx, a body over 2 MB, more than 64 projects, or a checksum that does not match. The page says the projects are still safe at the original address, says to go back and open the site again to retry, and links to the original address. The move is not a top-level navigation, so the browser's own error page is not what the visitor sees.

The POST is `application/x-www-form-urlencoded` with one field, `payload` (canonical JSON, or the older packed form). Above 2 MB the status is 413. A different content type is 415. A record that fails the schema is 400. Those responses are the failure page, send `Cache-Control: no-store`, and do not include the payload. The body is not logged and not written to disk. A second submit of the same projects merges in place and does not create a second copy. A different body for the same id is kept as “(moved copy)”.

## Turning the redirect on

1. Caddy is on 443 at `172.30.0.250` on `circuitlab-prod`, and `https://esp32lab.duckdns.org/api/health` answers. `https://esp32lab.duckdns.org/staging/` is served by Caddy from `esp32lab-staging:8765`.
2. Set `TRUSTED_PROXY_IPS=172.30.0.250` and `HTTPS_HOST=esp32lab.duckdns.org`. Leave `HTTPS_ENABLED=0` and recreate the app container. Plain HTTP pages are unchanged. `http://<the public IP>/staging/` is 502. A client that sends `X-Forwarded-Proto: https` still gets the HTTP site.
3. Set `HTTPS_ENABLED=1` and recreate. An asset on port 80 is 301 to `https://esp32lab.duckdns.org` with the path and query kept. `GET /` on HTTP is the handoff page. `GET /api/health` on HTTP is 200 with no `Location`. `GET /staging/...` on HTTP redirects to the same path on `https://esp32lab.duckdns.org`, which Caddy serves from the staging container.
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

To put `/staging/` back through the live app, set `STAGING_PROXY_ENABLED=1` and reconnect the live container to `circuitlab-staging` (`docker network connect circuitlab-staging esp32lab`). The network reconnect does not restart the container. The flag is read when the app process starts, so that part is a recreate. Caddy's `/staging*` route is what to remove in the server Caddyfile if https should stop going straight to the staging container. The server copy remains authoritative.

To take HTTPS off the host, stop `circuitlab-caddy` and close 443. Keep the data volume. The app keeps publishing port 80 only.

Previous app images, if the app container itself has to be rolled back: v66 `e3d38a538a45` (tag `rollback-keep-v66`) with `/home/opc/backup-v66`, and v65 `356f7c19711d` with `/home/opc/backup-v65`.
