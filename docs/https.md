# HTTPS for esp32lab.duckdns.org

The hostname is configuration. `HTTPS_HOST` defaults to empty, which leaves the redirect off. The documented value is `esp32lab.duckdns.org`, which already points at `129.158.200.25`. Any other single hostname works when `HTTPS_HOST` is set to it. Nothing in this repository opens port 443. The commands below are for an operator after Hari approves that step.

`HTTPS_ENABLED` defaults to `0`. While it is off, the process is plain HTTP: no TLS listener, no redirect, and no header this feature adds.

## Certificate

Let's Encrypt, HTTP-01, on the port 80 site that is already open. No paid certificate and no DNS API token. Certbot stays on the host. The container only reads the files.

Webroot, on the host, mounted read-only:

```
sudo mkdir -p /var/lib/esp32lab/acme
sudo chmod 755 /var/lib/esp32lab/acme
```

Check the client against the staging CA first so a mistake does not spend the production rate limit. This writes a staging certificate, which browsers will not trust. Use it on a staging copy or throw it away. Do not install it as the live certificate.

```
sudo certbot certonly --staging --webroot -w /var/lib/esp32lab/acme \
  -d esp32lab.duckdns.org \
  --agree-tos --register-unsafely-without-email --non-interactive \
  --dry-run
```

`--dry-run` checks the challenge without saving a certificate. After that succeeds, and only after Hari has approved the live cutover, issue once without `--staging`:

```
sudo certbot certonly --webroot -w /var/lib/esp32lab/acme \
  -d esp32lab.duckdns.org \
  --agree-tos --register-unsafely-without-email --non-interactive
```

A staging copy that must not share the production name can use a staging hostname of its own, for example `staging.esp32lab.duckdns.org`, still with `--staging` until the production name is needed. The staging container stays on the internal network. Do not publish 80, 443, or 8765 on it.

## When port 80 redirects

All four have to be true. Otherwise the site stays on HTTP and does not send browsers to 443.

1. `HTTPS_ENABLED=1`
2. `HTTPS_REDIRECT=1`
3. `HTTPS_HOST` is one hostname, such as `esp32lab.duckdns.org`
4. The TLS listener is up with a certificate that loaded

GET and HEAD of an asset or API path are 301 to `https://HTTPS_HOST` plus the path and query. Other methods are 308, so a form submit stays a form submit. A top-level HTML GET gets the same-page handoff that moves saved projects. `/.well-known/acme-challenge/` stays on plain HTTP so renewal can finish. `/api/health` stays on HTTP.

If issuance fails, or the key is missing, unreadable, or not a valid PEM, the process logs one error and keeps serving HTTP. Port 80 does not redirect.

## Renewal

Weekly timer: `docker/letsencrypt/esp32lab-certbot.timer`. The service runs `certbot renew --dry-run` and, only if that exits 0, `certbot renew`. A failed dry-run leaves the current certificate in place and does not reload the process.

Check renewal the same way, on the host:

```
sudo certbot renew --dry-run
```

After a real renewal, `docker/letsencrypt/esp32lab-deploy-hook.sh` checks that the new files load, then runs `docker kill -s HUP` on the container. The process reloads TLS and does not restart, so port 80 stays up. If the new files do not load, the hook logs the failure and does not signal. The certificate already in memory keeps serving. If a reload starts and the new listener does not stay up, the process logs that, leaves HTTP up, and stops redirecting so port 80 is not pointed at a broken 443.

Install the timer and the hook once, on the host. Disable the distro timer so renewal does not run twice:

```
sudo install -m 755 docker/letsencrypt/esp32lab-certbot-renew.sh /usr/local/sbin/esp32lab-certbot-renew
sudo install -m 755 docker/letsencrypt/esp32lab-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/esp32lab
sudo install -m 644 docker/letsencrypt/esp32lab-certbot.service /etc/systemd/system/esp32lab-certbot.service
sudo install -m 644 docker/letsencrypt/esp32lab-certbot.timer /etc/systemd/system/esp32lab-certbot.timer
sudo systemctl daemon-reload
sudo systemctl disable --now certbot.timer certbot-renew.timer
sudo systemctl enable --now esp32lab-certbot.timer
```

## HSTS

`HSTS_ENABLED` defaults to `0`. No `Strict-Transport-Security` header is sent. Later, after HTTPS has been checked on the live name, set `HSTS_ENABLED=1` and raise `HSTS_SECONDS` one step at a time: `300`, then `86400`, then `31536000`. The header is `max-age` only. No `includeSubDomains` and no `preload`.

## Opening port 443 later

Do this only after Hari says yes, and only after `curl` against the live name works from the host itself. Merging the pull request does not do it.

OCI security list: ingress TCP 443 from `0.0.0.0/0`. Do not add 8765.

If firewalld is running:

```
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

If the host uses iptables:

```
sudo iptables -I INPUT -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Recreate the container with host 443 mapped to container 8443. Redirect and HSTS stay off until the curl below succeeds. Replace the image name with the one just built.

```
docker rm -f esp32lab
docker run -d --name esp32lab --restart unless-stopped \
  -p 80:8765 \
  -p 443:8443 \
  -e HTTPS_ENABLED=1 \
  -e ACME_WEBROOT=/var/lib/esp32lab/acme \
  -e TLS_CERT_FILE=/etc/letsencrypt/live/esp32lab.duckdns.org/fullchain.pem \
  -e TLS_KEY_FILE=/etc/letsencrypt/live/esp32lab.duckdns.org/privkey.pem \
  -e HTTPS_HOST=esp32lab.duckdns.org \
  -e HTTPS_REDIRECT=0 \
  -e HSTS_ENABLED=0 \
  -e HSTS_SECONDS=0 \
  -e ALLOWED_HOSTS=129.158.200.25,esp32lab.duckdns.org \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -v /var/lib/esp32lab/acme:/var/lib/esp32lab/acme:ro \
  -v esp32lab-data:/home/sim/.esp32lab \
  -v esp32lab-cache:/home/sim/.cache/arduino \
  esp32-lab
```

Never `-p 8765`, `-p 8765:8765`, or `-p 8443:8443`.

Then, on the live host:

```
curl -sI https://esp32lab.duckdns.org/api/health
```

Only after that succeeds, recreate with `HTTPS_REDIRECT=1`. Leave `HSTS_ENABLED=0` until the redirect has been checked.

## Staging plan

Do this on a copy that is not the live host.

1. HTTP only. `HTTPS_ENABLED` unset. Save a project. Reload. It is still there. `/api/health` is `ok` from qemu and arduino-cli, and `tls.enabled` is false. The response has no `Location` and no `Strict-Transport-Security`.
2. `certbot certonly --staging --webroot` for a staging name, or `--dry-run` against `esp32lab.duckdns.org`. Do not use the production CA until the live cutover.
3. Mount that certificate with `HTTPS_ENABLED=1`, `HTTPS_REDIRECT=0`, `HSTS_ENABLED=0`. `curl --cacert` the HTTPS health URL from another container on `circuitlab-staging`. `tls.enabled` is true. `tls.warning` is false while 14 or more days remain.
4. Set `HTTPS_REDIRECT=1` with `HTTPS_HOST` set to that staging name. Open the HTTP address that has the saved project. The project appears on the new origin. The address bar does not keep the saved project, and Back does not show it. The HTTP copy is still there.
5. `curl -I` an asset and expect 301 to `https://HTTPS_HOST` with the query kept. `GET /` on HTTP returns the handoff page, not a 301. `GET /.well-known/acme-challenge/<token>` on HTTP returns the token file and is not redirected.
6. Remove the certificate files and start again with `HTTPS_REDIRECT=1`. The log names the failure. `GET /` on HTTP is the site, not a redirect.
7. Confirm the TLS response has no `Strict-Transport-Security` while `HSTS_ENABLED=0`.

## Rollback

1. Recreate the container with `HTTPS_ENABLED=0`, `HTTPS_REDIRECT=0`, and `HSTS_ENABLED=0`. Restart is the rollback. Renewal does not use restart.
2. Confirm plain HTTP. From the host:

```
curl -sI http://127.0.0.1/api/health
```

The status is 200. There is no `Location` header and no `Strict-Transport-Security` header. A browser that opens `http://esp32lab.duckdns.org/` gets the site, not a redirect.

3. Leave the certificate where it is. It is unused while the flag is off. To revoke it, on the host:

```
sudo certbot revoke --cert-name esp32lab.duckdns.org
```

Revoke only when the key is no longer trusted. Leaving the files in place is enough to roll the site back.

4. Close port 443. Drop `-p 443:8443` from the container. Remove the OCI ingress rule for TCP 443. If firewalld was opened: `sudo firewall-cmd --permanent --remove-port=443/tcp && sudo firewall-cmd --reload`. If iptables was opened, delete that ACCEPT rule and save.

HSTS that a browser already stored is not cleared by the flag. That is why `HSTS_ENABLED` stays 0 until the redirect has been checked.
