# Uptime fallback

UptimeRobot is the primary monitor. `.github/workflows/uptime.yml` is a free fallback. GitHub may delay or skip a scheduled run when Actions is busy, and it can disable the schedule after a long stretch of repository inactivity. A missed slot is not, by itself, an outage. Treat this workflow as best-effort.

The workflow does not change the site. It sends no repository secrets.

## What it checks

The schedule is `*/5 * * * *`. `workflow_dispatch` runs the same job. One run at a time: a second run waits, so the server never sees two checks at once. A wait that Actions cancels is not counted as the site being down.

`UPTIME_TARGETS` at the top of the workflow is the only list. In order, one GET at a time:

- `https://esp32lab.duckdns.org/api/health`
- `https://esp32lab.duckdns.org/`
- `http://129.158.200.25/api/health`
- `http://129.158.200.25/`

There is no compile call and no other path. Each request is `curl --request GET` with a 10 second connect timeout, a 20 second max time, and 2 retries. Connection refused is retried. Curl also retries its usual transient HTTP statuses (408, 429, 500, 502, 503, 504) and timeouts. The user agent is `esp32-lab-uptime`. Redirects are not followed: the status we record is the status of that URL.

Every URL must return HTTP 200.

`/api/health` must also be JSON whose `ok` field is the boolean `true`, the same field `health()` returns from `web/server/server.py`. A string, a number, or a missing field fails the check. The issue text does not include the rest of the body.

Any other URL is the homepage. It must contain this marker, which is the `<title>` in `web/index.html`:

`ESP32 Circuit Lab — real-firmware ESP32 + electronics simulator`

That string is `UPTIME_HOME_MARKER` in the workflow. If the title changes, change the variable in the same edit.

The job stops after 8 minutes so a stuck check cannot sit on the server.

## How alerts work

State is an open GitHub issue labeled `uptime`. Nothing is stored outside the repository.

1. **Ok.** Every target passes and no `uptime` issue is open. The run succeeds.
2. **One failure.** A target fails, no `uptime` issue is open, and the previous scheduled run of this workflow that actually finished did not fail. The run fails. No issue is opened.
3. **Two failures.** A target fails, no `uptime` issue is open, and that previous scheduled run's conclusion is `failure` or `timed_out`. The workflow opens an issue titled `Site down: <target>` using the first failing URL. The body lists the failing targets, the HTTP status, connect / start / total seconds, and links to this run and the previous scheduled run. A `cancelled` run is ignored when looking for that previous result.
4. **Still down.** A target fails and an `uptime` issue is already open. The workflow adds a comment with the same details, at most once per hour, measured from the issue or its latest comment. It does not open a second issue.
5. **Recovered.** Every target passes and an `uptime` issue is open. The workflow comments `Recovered` and closes the issue.

The runs lookup uses `gh api`. The job token only has `contents: read` and `issues: write`, so that call can be denied. The repository is public, and the same GET is then tried without the token. If the runs API still cannot be read, no issue is opened. The run is still a failure, so a later check can see it once the API answers.

A green `workflow_dispatch` closes an open issue. It does not erase a previous scheduled failure: the next scheduled failure still looks at that scheduled run.

## How to turn it off

Repository variable `UPTIME_CHECK_ENABLED`. The job runs unless the value is exactly `0`.

Settings → Secrets and variables → Actions → Variables → `UPTIME_CHECK_ENABLED` = `0`.

Unset, empty, or any other value leaves the check on. This includes a manual run. The variable is not a secret. The workflow reads no repository secrets. `GH_TOKEN` in the job is the automatic `github.token`.

While the variable is `0`, the job is skipped. That run is a success, not a failure, and it does not count as the site being down.

Rollback is either of these:

- Set `UPTIME_CHECK_ENABLED` to `0`.
- Delete `.github/workflows/uptime.yml`.

Neither touches the server or its configuration.
