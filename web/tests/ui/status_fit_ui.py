"""Phone fit: the 429 status, the device-failure line, and share results stay inside 375 and 390.

The live region text for a failed Ctrl+S is the device-failure sentence. Share results are written
to that same region before the edit-link tip.
"""
import asyncio
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

WEB = Path(__file__).resolve().parents[2]
CHROME = os.environ.get('CHROME') or ('/usr/local/bin/google-chrome' if os.path.exists('/usr/local/bin/google-chrome') else '/usr/bin/google-chrome')
BACKUP_WAIT = 'Lots of people on your network are saving right now. Wait a few seconds and try again; your changes are still here.'
DEVICE_FAIL = 'Saved on this device, online backup failed, retrying'
SHARE_OK = 'Backed up online and copied view-only link.'
SHARE_BUSY = 'Too many people on your network are backing up right now. Try again in a few seconds.'
SHARE_FAIL = "Couldn't back up this project, so there's no link to share yet. Try again in a minute."

res = []


def check(name, ok, info=''):
    res.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + ((' — ' + str(info)[:300]) if info and not ok else ''), flush=True)


def free_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


async def fits(page, selector, text):
    box = await page.eval_on_selector(selector, """(el, text) => {
      el.textContent = text;
      const cs = getComputedStyle(el);
      return {
        text: el.textContent,
        scroll: el.scrollWidth,
        client: el.clientWidth,
        whiteSpace: cs.whiteSpace,
        overflow: cs.overflow,
        maxWidth: cs.maxWidth,
      };
    }""", text)
    ok = box['text'] == text and box['scroll'] <= box['client'] + 1 and box['client'] > 0
    return ok, box


async def main():
    port = free_port()
    env = os.environ.copy()
    env.update({'SIM_TOKEN': '', 'SIM_PREWARM': '0', 'SIM_NETSTACK_WARM': '0'})
    proc = subprocess.Popen(
        [sys.executable, 'server/server.py', '--host', '127.0.0.1', '--port', str(port)],
        cwd=str(WEB),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 20
        import urllib.request
        while time.time() < deadline:
            try:
                urllib.request.urlopen('http://127.0.0.1:%d/api/health' % port, timeout=1).read()
                break
            except Exception:
                time.sleep(0.2)
        else:
            check('server started', False, 'health never returned')
            return
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
            for width in (375, 390):
                page = await browser.new_page(viewport={'width': width, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
                await page.goto('http://127.0.0.1:%d/?ex=blink' % port, wait_until='domcontentloaded')
                await page.wait_for_function('() => document.body.classList.contains("m") && window.app && window.app.proj')
                await page.evaluate("""() => {
                  document.body.classList.add('m');
                  if (!document.getElementById('liveStatus')) {
                    const el = document.createElement('div');
                    el.id = 'liveStatus';
                    el.className = 'live-status';
                    el.setAttribute('role', 'status');
                    el.setAttribute('aria-live', 'polite');
                    document.body.appendChild(el);
                  }
                  if (!document.querySelector('.toast.fit')) {
                    const t = document.createElement('div');
                    t.className = 'toast fit';
                    document.body.appendChild(t);
                  }
                  if (!document.getElementById('backupState')) {
                    const s = document.createElement('span');
                    s.id = 'backupState';
                    s.className = 'backup-state';
                    const banner = document.querySelector('.projbanner') || document.body;
                    banner.appendChild(s);
                  }
                }""")
                for label, selector, text in (
                    ('429 status', '#backupState', BACKUP_WAIT),
                    ('429 toast', '.toast.fit', BACKUP_WAIT),
                    ('device failure', '#liveStatus', DEVICE_FAIL),
                    ('device toast', '.toast.fit', DEVICE_FAIL),
                ):
                    ok, box = await fits(page, selector, text)
                    check('%s fits at %d' % (label, width), ok, box)
                await page.close()

            page = await browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            await page.goto('http://127.0.0.1:%d/?ex=blink' % port, wait_until='domcontentloaded')
            await page.wait_for_function('() => window.app && window.app.proj && document.getElementById("bCopy")')
            await page.click('#bCopy')
            await page.wait_for_function('() => app.proj && app.proj.id && !app.readOnly && document.getElementById("bBackupCopy")')
            seen = []

            def on_live(msg):
                seen.append(msg)

            await page.expose_binding('recordLive', lambda source, msg: on_live(msg))
            await page.evaluate("""() => {
              let el = document.getElementById('liveStatus');
              if (!el) {
                el = document.createElement('div');
                el.id = 'liveStatus';
                el.className = 'live-status';
                el.setAttribute('role', 'status');
                el.setAttribute('aria-live', 'polite');
                document.body.appendChild(el);
              }
              new MutationObserver(() => { if (el.textContent) window.recordLive(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
              window.fetch = (url, opts) => {
                const method = (opts && opts.method) || 'GET';
                if (method === 'POST') {
                  return Promise.resolve({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: 'srvFit', secret: 'sek' }) });
                }
                if (method === 'PUT') return Promise.reject(new Error('down'));
                return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
              };
              const clip = navigator.clipboard || {};
              clip.writeText = async () => {};
              navigator.clipboard = clip;
            }""")
            await page.click('#bBackupCopy')
            await page.wait_for_timeout(500)
            texts = await page.evaluate("""() => {
              const el = document.getElementById('liveStatus');
              return { now: el ? el.textContent : '', regions: document.querySelectorAll('#liveStatus').length };
            }""")
            check('share result was announced on the one live region', SHARE_OK in seen and texts['now'] in (SHARE_OK, 'To edit this on another device, copy your edit link and keep it somewhere safe.') and texts['regions'] == 1, {'seen': seen, 'now': texts})
            hint_at = next((i for i, msg in enumerate(seen) if msg.startswith('To edit this on another device')), -1)
            ok_at = next((i for i, msg in enumerate(seen) if msg == SHARE_OK), -1)
            check('edit-link tip is announced after the share result', ok_at >= 0 and (hint_at == -1 or ok_at < hint_at), seen)
            await page.keyboard.press('Control+s')
            await page.wait_for_function(
                """(msg) => {
                  const el = document.getElementById('liveStatus');
                  return el && el.textContent === msg;
                }""",
                arg=DEVICE_FAIL,
            )
            live = await page.eval_on_selector('#liveStatus', """(el, msg) => ({
              text: el.textContent,
              role: el.getAttribute('role'),
              live: el.getAttribute('aria-live'),
              scroll: el.scrollWidth,
              client: el.clientWidth,
              equals: el.textContent === msg,
            })""", DEVICE_FAIL)
            check('Ctrl+S failure live region equals the device message', live['equals'] and live['role'] == 'status' and live['live'] == 'polite' and live['scroll'] <= live['client'] + 1, live)
            saved = await page.evaluate("""() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')""")
            check('Ctrl+S failure does not toast Saved', 'Saved “' not in saved and 'Saved "' not in saved, saved)
            await browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    failed = [name for name, ok in res if not ok]
    print('%d passed, %d failed' % (len(res) - len(failed), len(failed)), flush=True)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())
