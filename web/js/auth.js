/* Sign-in. With the flag off the page has no cl-auth meta, and this file
   does not request /auth/session. The lab, examples, Run, and a local save
   never wait on an account, and sign-in never uploads guest projects. */
(function (root) {
  const CANCELLED = 'Sign-in cancelled — your work is still here';
  let session = null;
  let authStatus = 'idle', sessionRequest = null, emailAttempt = null, emailAddress = '';
  let emailTimer = 0, emailController = null, emailSequence = 0, lastAccountSave = null, authFailure = null;

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function toast(msg, err) {
    if (root.app && root.app.cmd && root.app.cmd.toast) root.app.cmd.toast(msg, !!err);
    if (typeof document !== 'undefined') {
      let live = document.getElementById('authLive');
      if (!live) {
        live = document.createElement('p'); live.id = 'authLive'; live.className = 'sr-only';
        live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); document.body.appendChild(live);
      }
      live.textContent = msg;
    }
  }
  class AuthError extends Error {
    constructor(message, status, data, retryAfter) {
      super(message); this.status = status || 0; this.data = data || null; this.retryAfter = retryAfter || 0;
    }
  }
  async function requestJSON(path, options) {
    const opts = options || {}, controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) cancel();
      else opts.signal.addEventListener('abort', cancel, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      let response;
      try {
        response = await fetch(here(path), {
          ...opts, credentials: 'same-origin', headers: { accept: 'application/json', ...(opts.headers || {}) },
          signal: controller.signal,
        });
      } catch (error) {
        const failure = new AuthError(timedOut ? 'The account request timed out. Try again.' : "Couldn't reach the account service. Try again.");
        failure.cancelled = !!(opts.signal && opts.signal.aborted && !timedOut);
        throw failure;
      }
      let data;
      try { data = await response.json(); }
      catch (error) {
        const failure = new AuthError(timedOut ? 'The account request timed out. Try again.' : 'The account service returned an unreadable response. Try again.', response.status);
        failure.cancelled = !!(opts.signal && opts.signal.aborted && !timedOut);
        throw failure;
      }
      const retry = Math.max(0, Number(response.headers.get('Retry-After')) || Number(data && data.retry_after) || 0);
      if (!response.ok) throw new AuthError(
        data && typeof data.message === 'string' ? data.message : 'The account request failed. Try again.',
        response.status, data, retry,
      );
      if (!data || typeof data !== 'object') throw new AuthError('The account service returned an incomplete response. Try again.');
      return data;
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', cancel);
    }
  }
  function getState() {
    return {
      enabled: typeof document !== 'undefined' && authOn(), status: authStatus,
      signed_in: !!(session && session.signed_in), display_name: session && session.display_name || '',
      provider: session && session.provider || '', available: providerList().length > 0,
      last_saved: lastAccountSave,
    };
  }
  function notifyState() {
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('authchange'));
    }
  }
  function message(node, text, error) {
    node.textContent = text;
    node.setAttribute('role', error ? 'alert' : 'status');
    node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  }
  function preserveWork() {
    return !(root.app && root.app.flushAutosave) || root.app.flushAutosave();
  }
  function savedSentence(n) {
    return n + (n === 1 ? ' project saved to your account' : ' projects saved to your account');
  }
  function originOf() {
    if (location && location.origin) return location.origin;
    try { return new URL(location.href).origin; } catch (e) { return 'http://localhost'; }
  }
  function authBase() {
    // AUTH_BASE_URL's path, injected as cl-auth-base. Otherwise the directory
    // of this page, so /staging and /staging/ both stay on the staging mount.
    try {
      const meta = document.querySelector('meta[name="cl-auth-base"]');
      if (meta) {
        let value = String(meta.getAttribute('content') || '');
        if (value.charAt(0) === '/' && value.indexOf('//') !== 0 && value.indexOf('\\') < 0) {
          value = value.replace(/\/+$/, '');
          return value === '/' ? '' : value;
        }
      }
    } catch (e) { /* no document yet */ }
    let path = (location && location.pathname) || '/';
    if (path.charAt(0) !== '/' || path.indexOf('//') === 0 || path.indexOf('\\') !== -1) path = '/';
    if (path.charAt(path.length - 1) !== '/') {
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (last.indexOf('.') < 0) path += '/';
    }
    const slash = path.lastIndexOf('/');
    return slash <= 0 ? '' : path.slice(0, slash);
  }
  function here(path) {
    const rel = String(path || '').replace(/^\/+/, '');
    const base = authBase();
    const root = originOf() + (base ? base + '/' : '/');
    return new URL(rel, root);
  }
  const BRANDS = { google: 'Google', github: 'GitHub', email: 'Email', facebook: 'Facebook', x: 'X', twitter: 'X' };
  const BRAND_ORDER = ['google', 'github', 'facebook', 'x', 'twitter'];
  const LEAD = 'Sign in or create an account to unlock all parts. Save projects to your account when you choose. Local copies stay on this device.';
  let opener = null;
  let trap = null;

  function brandName(id) {
    if (BRANDS[id]) return BRANDS[id];
    const raw = String(id || '');
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'this account';
  }
  function providerList() {
    const providers = (session && session.providers) || {};
    const ids = Object.keys(providers).filter((id) => providers[id]);
    ids.sort((a, b) => {
      const ia = BRAND_ORDER.indexOf(a);
      const ib = BRAND_ORDER.indexOf(b);
      if (ia < 0 && ib < 0) return a < b ? -1 : a > b ? 1 : 0;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    return ids.map((id) => [id, brandName(id)]);
  }
  function partLine(label) {
    const name = String(label || '').replace(/\s+/g, ' ').trim();
    if (!name) return '';
    if (/^sign in free to use/i.test(name)) return name;
    return 'Sign in free to use ' + (/^the\b/i.test(name) ? '' : 'the ') + name;
  }
  function focusables(box) {
    return [...box.querySelectorAll('button, a[href], input, select, textarea')].filter((el) =>
      !el.disabled && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0);
  }
  function focusBack(preferred) {
    const candidates = [preferred, document.getElementById('ui2Sign'),
      document.querySelector('#ui2Phone [data-a="more"]'), document.getElementById('bProjects'),
      document.getElementById('mSignIn'), document.getElementById('bSignIn'),
      document.getElementById('mSignOut'), document.getElementById('bSignOut')];
    const back = candidates.find((el) => el && el !== document.body && el.isConnected && !el.disabled
      && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0);
    if (back) back.focus();
  }
  function closeWindow() {
    const dlg = document.getElementById('authDlg');
    if (dlg) dlg.hidden = true;
    const sign = document.getElementById('bSignIn');
    if (sign) sign.setAttribute('aria-expanded', 'false');
    if (trap) {
      document.removeEventListener('keydown', trap, true);
      trap = null;
    }
    clearInterval(emailTimer); emailTimer = 0;
    if (emailController) emailController.abort();
    const back = opener;
    if (opener && opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'false');
    opener = null;
    focusBack(back);
  }
  function ensureWindow() {
    let dlg = document.getElementById('authDlg');
    if (dlg) return dlg;
    dlg = document.createElement('div');
    dlg.id = 'authDlg';
    dlg.className = 'modal auth-dlg';
    dlg.hidden = true;
    const box = document.createElement('div');
    box.className = 'modal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'authDlgTitle');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'auth-x';
    close.id = 'authDlgClose';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(); });
    const title = document.createElement('h2');
    title.id = 'authDlgTitle';
    title.textContent = 'Sign in';
    const part = document.createElement('p');
    part.id = 'authDlgPart';
    part.hidden = true;
    const lead = document.createElement('p');
    lead.id = 'authDlgLead';
    lead.textContent = LEAD;
    const choices = document.createElement('div');
    choices.id = 'authDlgChoices';
    choices.className = 'auth-choices';
    box.append(close, title, part, lead, choices);
    dlg.appendChild(box);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) closeWindow();
    });
    document.body.appendChild(dlg);
    return dlg;
  }
  function openWindow(opts) {
    if (session && session.signed_in) return false;
    if (!authOn() && !session) return false;
    const dlg = ensureWindow();
    const title = document.getElementById('authDlgTitle');
    const part = document.getElementById('authDlgPart');
    const line = partLine(opts && opts.part);
    title.textContent = 'Sign in or create an account';
    if (line) {
      part.hidden = false;
      part.textContent = line;
    } else if (part) {
      part.hidden = true;
      part.textContent = '';
    }
    const from = (opts && opts.opener) || document.activeElement;
    opener = from && from !== document.body ? from : document.getElementById('bSignIn');
    if (opener && opener.getAttribute('aria-haspopup') === 'dialog') opener.setAttribute('aria-expanded', 'true');
    const sign = document.getElementById('bSignIn');
    if (sign) sign.setAttribute('aria-expanded', 'true');
    dlg.hidden = false;
    renderWindow();
    if (trap) document.removeEventListener('keydown', trap, true);
    trap = (e) => {
      if (dlg.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeWindow();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(dlg);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      if (e.shiftKey) items[i <= 0 ? items.length - 1 : i - 1].focus();
      else items[(i + 1) % items.length].focus();
    };
    document.addEventListener('keydown', trap, true);
    const first = document.getElementById('authEmailCode') && !document.getElementById('authEmailCodeForm').hidden
      ? document.getElementById('authEmailCode') : focusables(document.getElementById('authDlgChoices'))[0] || document.getElementById('authDlgClose');
    if (first) first.focus();
    return true;
  }
  function emailStorageKey() { return 'cl_auth_email:' + authBase(); }
  function rememberEmail(next) {
    emailAttempt = next;
    const bag = sessionBag();
    if (!bag) return;
    try {
      if (next) bag.setItem(emailStorageKey(), JSON.stringify(next));
      else bag.removeItem(emailStorageKey());
    } catch (error) { /* The same open tab can still finish sign-in without session storage. */ }
  }
  function pendingEmail() {
    if (!emailAttempt) {
      const bag = sessionBag();
      try {
        const saved = bag && bag.getItem(emailStorageKey());
        if (saved) emailAttempt = JSON.parse(saved);
      } catch (error) { rememberEmail(null); }
    }
    const p = emailAttempt;
    if (p && (typeof p.email !== 'string' || typeof p.challenge !== 'string' || typeof p.csrf !== 'string'
        || !Number.isFinite(p.expiresAt) || !Number.isFinite(p.resendAt) || p.expiresAt <= Date.now())) rememberEmail(null);
    return emailAttempt;
  }
  function renderWindow() {
    const list = document.getElementById('authDlgChoices');
    if (!list) return;
    const refocus = list.contains(document.activeElement);
    clearInterval(emailTimer); emailTimer = 0;
    list.textContent = '';
    document.getElementById('authDlgLead').textContent = LEAD;
    if (authStatus === 'loading') {
      const status = document.createElement('p'); message(status, 'Checking sign-in options...');
      list.appendChild(status);
      if (refocus) { status.tabIndex = -1; status.focus(); }
      return;
    }
    const choices = providerList();
    if (authStatus === 'error' || !choices.length) {
      const status = document.createElement('p'); status.id = 'authSessionError';
      const wait = authFailure && authFailure.retryAfter ? ' Try again in ' + Math.ceil(authFailure.retryAfter) + ' seconds.' : '';
      message(status, 'Sign-in is unavailable right now. Your local projects are still here.' + wait, true);
      const retry = document.createElement('button'); retry.type = 'button'; retry.id = 'authSessionRetry'; retry.textContent = 'Try again';
      retry.onclick = () => refreshSession();
      list.append(status, retry);
      if (refocus) retry.focus();
      return;
    }
    const email = choices.some(([id]) => id === 'email');
    const pending = email && pendingEmail();
    if (!pending) {
      choices.filter(([id]) => id !== 'email').forEach(([id, brand]) => {
        const b = providerButton(id, 'Continue with ' + brand);
        b.classList.add('auth-brand'); b.insertBefore(brandMark(id, brand), b.firstChild); list.appendChild(b);
      });
    }
    if (email) buildEmailForm(list, pending);
    const note = document.createElement('p'); note.className = 'auth-note';
    note.textContent = 'Use the same sign-in method to return to an existing account. Accounts using different methods are not automatically linked.';
    list.appendChild(note);
    if (refocus) {
      const code = document.getElementById('authEmailCodeForm');
      const first = code && !code.hidden ? document.getElementById('authEmailCode') : focusables(list)[0];
      if (first) first.focus();
    }
  }
  function buildEmailForm(host, pending) {
    if (pending) emailAddress = pending.email;
    const start = document.createElement('form'); start.id = 'authEmailForm'; start.className = 'auth-email-form';
    start.hidden = !!pending;
    const label = document.createElement('label'); label.htmlFor = 'authEmailAddress'; label.textContent = 'Email address';
    const address = document.createElement('input');
    address.id = 'authEmailAddress'; address.name = 'email'; address.type = 'email'; address.autocomplete = 'email';
    address.inputMode = 'email'; address.required = true; address.maxLength = 254; address.spellcheck = false;
    address.value = pending ? pending.email : emailAddress;
    address.setAttribute('aria-describedby', 'authEmailHelp authEmailMessage');
    address.oninput = () => { emailAddress = address.value; address.removeAttribute('aria-invalid'); };
    const help = document.createElement('p'); help.id = 'authEmailHelp'; help.className = 'auth-note';
    help.textContent = 'No password needed. We will email a six-digit code valid for 10 minutes. Your account is created only after verification.';
    const send = document.createElement('button'); send.type = 'submit'; send.id = 'authEmailSend'; send.className = 'primary'; send.textContent = 'Email me a code';
    const status = document.createElement('p'); status.id = 'authEmailMessage'; status.className = 'auth-message';
    status.setAttribute('aria-live', 'polite');
    start.append(label, address, help, send);
    const verify = document.createElement('form'); verify.id = 'authEmailCodeForm'; verify.className = 'auth-email-form'; verify.hidden = !pending;
    const sent = document.createElement('p'); sent.id = 'authEmailSent'; sent.className = 'auth-note';
    const codeLabel = document.createElement('label'); codeLabel.htmlFor = 'authEmailCode'; codeLabel.textContent = 'Six-digit email code';
    const code = document.createElement('input');
    code.id = 'authEmailCode'; code.name = 'code'; code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code';
    code.required = true; code.maxLength = 12; code.pattern = '[0-9]{6}'; code.spellcheck = false;
    code.setAttribute('aria-describedby', 'authEmailMessage');
    code.oninput = () => { code.value = code.value.replace(/[\s-]/g, ''); code.removeAttribute('aria-invalid'); };
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.id = 'authEmailVerify'; confirm.className = 'primary'; confirm.textContent = 'Verify and sign in';
    const row = document.createElement('div'); row.className = 'auth-email-actions';
    const resend = document.createElement('button'); resend.type = 'button'; resend.id = 'authEmailResend'; resend.textContent = 'Resend code';
    const change = document.createElement('button'); change.type = 'button'; change.id = 'authEmailChange'; change.textContent = 'Use another email';
    row.append(resend, change); verify.append(sent, codeLabel, code, confirm, row);
    host.append(start, verify, status);
    const showCode = () => {
      start.hidden = true; verify.hidden = false;
      sent.textContent = 'Code sent to ' + emailAttempt.email + '. Enter it in this browser.';
      const tick = () => {
        if (!emailAttempt) { clearInterval(emailTimer); emailTimer = 0; return; }
        const wait = Math.max(0, Math.ceil((emailAttempt.resendAt - Date.now()) / 1000));
        resend.disabled = wait > 0 || !!emailController;
        resend.setAttribute('aria-disabled', resend.disabled ? 'true' : 'false');
        resend.textContent = wait ? 'Resend code (' + wait + 's)' : 'Resend code';
        if (Date.now() >= emailAttempt.expiresAt) {
          confirm.disabled = true;
          message(status, 'This code has expired. Request a new code.', true);
          clearInterval(emailTimer); emailTimer = 0;
        }
      };
      clearInterval(emailTimer); tick(); emailTimer = setInterval(tick, 1000);
    };
    const sendCode = async () => {
      if (!preserveWork()) return;
      const email = (verify.hidden ? address.value : emailAttempt.email).trim();
      emailAddress = email;
      const sequence = ++emailSequence, controller = new AbortController();
      emailController = controller; setBusy(send, true); setBusy(resend, true);
      send.textContent = 'Sending code...'; change.disabled = true;
      message(status, 'Sending your sign-in code...');
      try {
        const data = await requestJSON('auth/email/start', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, next: returnTarget() }), signal: controller.signal,
        });
        if (!data.ok || typeof data.challenge !== 'string' || typeof data.csrf !== 'string'
            || !Number.isFinite(data.expires_in) || !Number.isFinite(data.resend_after)) {
          throw new AuthError('The email service returned an incomplete response. Try again.');
        }
        if (sequence !== emailSequence) return;
        rememberEmail({ email, challenge: data.challenge, csrf: data.csrf,
          expiresAt: Date.now() + data.expires_in * 1000, resendAt: Date.now() + data.resend_after * 1000 });
        code.value = ''; code.removeAttribute('aria-invalid'); confirm.disabled = false;
        if (document.getElementById('authDlg').hidden) return;
        showCode(); message(status, 'Check your inbox and spam folder for the code.');
        if (!document.getElementById('authDlg').hidden) code.focus();
      } catch (error) {
        if (sequence === emailSequence && !error.cancelled && !document.getElementById('authDlg').hidden) {
          if (error.data && error.data.error === 'signed_in') { await refreshSession(); return; }
          if (error.data && error.data.error === 'delivery') {
            rememberEmail(null); clearInterval(emailTimer); emailTimer = 0;
            start.hidden = false; verify.hidden = true;
          }
          const wait = error.retryAfter ? ' Try again in ' + Math.ceil(error.retryAfter) + ' seconds.' : '';
          message(status, error.message + wait, true);
          if (verify.hidden) { address.setAttribute('aria-invalid', error.status === 422 ? 'true' : 'false'); address.focus(); }
        }
      } finally {
        if (emailController === controller) emailController = null;
        setBusy(send, false); send.textContent = 'Email me a code'; change.disabled = false;
        resend.setAttribute('aria-busy', 'false');
        if (verify.hidden) setBusy(resend, false);
      }
    };
    start.onsubmit = (event) => { event.preventDefault(); sendCode(); };
    resend.onclick = sendCode;
    change.onclick = () => {
      rememberEmail(null); clearInterval(emailTimer); emailTimer = 0;
      start.hidden = false; verify.hidden = true; message(status, '');
      address.value = emailAddress; address.focus();
    };
    verify.onsubmit = async (event) => {
      event.preventDefault();
      if (!emailAttempt || !preserveWork()) return;
      let blocked = false;
      const sequence = ++emailSequence, controller = new AbortController();
      emailController = controller; setBusy(confirm, true); change.disabled = true; resend.disabled = true;
      confirm.textContent = 'Signing in...'; message(status, 'Verifying your email code...');
      try {
        const data = await requestJSON('auth/email/verify', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': emailAttempt.csrf },
          body: JSON.stringify({ challenge: emailAttempt.challenge, csrf: emailAttempt.csrf, code: code.value }),
          signal: controller.signal,
        });
        if (!data.ok || typeof data.redirect !== 'string' || !data.redirect.startsWith('/') || data.redirect.startsWith('//')
            || new URL(data.redirect, originOf()).origin !== originOf()) throw new AuthError('Sign-in returned an invalid address. Try again.');
        if (sequence !== emailSequence || document.getElementById('authDlg').hidden) { await refreshSession(); return; }
        rememberEmail(null); clearInterval(emailTimer); emailTimer = 0;
        location.assign(data.redirect);
      } catch (error) {
        if (sequence === emailSequence && !error.cancelled && !document.getElementById('authDlg').hidden) {
          if (error.data && error.data.error === 'csrf') { rememberEmail(null); await refreshSession(); return; }
          message(status, error.message, true);
          code.setAttribute('aria-invalid', 'true');
          if (!document.getElementById('authDlg').hidden) code.focus();
          blocked = !!(error.data && ['code_expired', 'code_locked', 'csrf'].includes(error.data.error));
        }
      } finally {
        if (emailController === controller) emailController = null;
        confirm.textContent = 'Verify and sign in'; change.disabled = false;
        setBusy(confirm, false);
        confirm.disabled = blocked || !!(emailAttempt && emailAttempt.expiresAt <= Date.now());
        confirm.setAttribute('aria-disabled', confirm.disabled ? 'true' : 'false');
        resend.setAttribute('aria-busy', 'false');
      }
    };
    if (pending) showCode();
  }
  function openMenu(opts) {
    return openWindow(opts);
  }
  function sessionBag() {
    return root.clStorage && root.clStorage.session;
  }
  function importMark() {
    const bag = sessionBag();
    if (!bag) return '';
    try { return bag.getItem('cl_auth_import') || ''; } catch (e) { return ''; }
  }
  function setImportMark(value) {
    const bag = sessionBag();
    if (!bag) return;
    try {
      if (value) bag.setItem('cl_auth_import', value);
      else bag.removeItem('cl_auth_import');
    } catch (e) { /* private mode */ }
  }
  function viewName() {
    if (document.body.classList.contains('viewsch')) return 'schematic';
    if (document.body.classList.contains('view3d')) return '3d';
    return '';
  }
  function returnTarget() {
    let path = location.pathname || '/';
    if (path.charAt(0) !== '/' || path.indexOf('//') === 0 || path.indexOf('\\') !== -1) path = '/';
    const sp = new URLSearchParams(location.search);
    ['auth_error', 'signin', 't'].forEach((k) => sp.delete(k));
    const view = viewName();
    if (view && view !== '2d') sp.set('view', view);
    else sp.delete('view');
    const q = sp.toString();
    return path + (q ? '?' + q : '');
  }
  function svgMark() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'auth-mark');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  }
  function svgPath(svg, d, fill) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.appendChild(path);
    return path;
  }
  function brandMark(id, brand) {
    // Drawn here. No image request. The button text is the accessible name.
    if (id === 'google') {
      const svg = svgMark();
      svgPath(svg, 'M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.56-5.16 3.56-8.65z', '#4285F4');
      svgPath(svg, 'M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.87-3c-1.08.72-2.45 1.15-4.08 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09A12 12 0 0 0 12 24z', '#34A853');
      svgPath(svg, 'M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.63H1.26a12 12 0 0 0 0 10.74l4.01-3.09z', '#FBBC05');
      svgPath(svg, 'M12 4.75c1.77 0 3.35.61 4.6 1.8l3.45-3.45C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.26 6.63l4.01 3.09C6.22 6.86 8.87 4.75 12 4.75z', '#EA4335');
      return svg;
    }
    if (id === 'github') {
      const svg = svgMark();
      svgPath(svg, 'M12 .3C5.37.3 0 5.67 0 12.3c0 5.3 3.44 9.8 8.21 11.38.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.02 12.02 0 0 0 24 12.3C24 5.67 18.63.3 12 .3z', 'currentColor');
      return svg;
    }
    const mark = document.createElement('span');
    mark.className = 'auth-mark auth-letter';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = String(brand || id || '?').charAt(0);
    return mark;
  }
  function providerButton(provider, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'auth-go';
    b.dataset.provider = provider;
    b.textContent = label;
    b.addEventListener('click', () => begin(provider, b));
    return b;
  }
  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.setAttribute('aria-disabled', on ? 'true' : 'false');
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  async function begin(provider, btn) {
    if (!session || session.signed_in) return;
    if (!preserveWork()) return;
    setBusy(btn, true);
    try {
      const url = here('auth/' + provider);
      url.searchParams.set('next', returnTarget());
      location.assign(url.href);
    } catch (e) {
      setBusy(btn, false);
      toast('Sign-in could not be started. Your work is still on this device.', true);
    }
  }
  function mountHeader() {
    const tb = document.querySelector('header .tb');
    if (!tb) return;
    let slot = $('#authSlot');
    if (!slot) { slot = document.createElement('div'); slot.id = 'authSlot'; slot.className = 'auth-slot'; }
    slot.textContent = '';
    if (session && session.signed_in) {
      const name = document.createElement('span');
      name.id = 'authName';
      name.className = 'auth-who';
      name.textContent = session.display_name || 'Signed in';
      const out = document.createElement('button');
      out.type = 'button';
      out.id = 'bSignOut';
      out.textContent = 'Sign out';
      out.addEventListener('click', () => signOut(out));
      slot.append(name, out);
    } else {
      if (!providerList().length && authStatus !== 'error' && authStatus !== 'loading') { slot.remove(); return; }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'bSignIn';
      btn.textContent = 'Sign in';
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', 'authDlg');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openWindow({ opener: btn });
      });
      slot.appendChild(btn);
    }
    const dot = $('#connDot');
    if (dot && dot.parentNode === tb) tb.insertBefore(slot, dot);
    else tb.appendChild(slot);
  }
  function accountHeading() {
    const title = document.createElement('h2');
    title.className = 'm-lbl';
    title.id = 'mAuthTitle';
    title.textContent = 'Account';
    return title;
  }
  function mountMobile() {
    const more = $('#mMore .m-more-b');
    if (!more || (!session && authStatus !== 'error' && authStatus !== 'loading')) return;
    let box = $('#mAuth');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mAuth';
      box.className = 'm-grp';
      more.insertBefore(box, more.firstChild);
    }
    box.textContent = '';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', 'mAuthTitle');
    if (session && session.signed_in) {
      const name = document.createElement('p');
      name.className = 'auth-who';
      name.id = 'mAuthName';
      name.textContent = session.display_name || 'Signed in';
      const out = document.createElement('button');
      out.type = 'button';
      out.id = 'mSignOut';
      out.textContent = 'Sign out';
      out.addEventListener('click', () => signOut(out));
      box.append(accountHeading(), name, out);
      return;
    }
    if (!providerList().length && authStatus !== 'error' && authStatus !== 'loading') { box.remove(); return; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mSignIn';
    btn.textContent = 'Sign in';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openWindow({ opener: btn });
    });
    box.append(accountHeading(), btn);
  }
  function accountWhen(updated) {
    const t = Number(updated);
    if (!Number.isFinite(t) || t <= 0) return 'Last saved';
    const ms = t < 1e12 ? t * 1000 : t;
    try { return 'Last saved ' + new Date(ms).toLocaleString(); }
    catch (e) { return 'Last saved'; }
  }
  function showAccountError(group, status) {
    status.textContent = "Couldn't load the projects in your account.";
    let again = group.querySelector('#authAccountRetry');
    if (!again) {
      again = document.createElement('button');
      again.type = 'button';
      again.id = 'authAccountRetry';
      again.textContent = 'Try again';
      group.appendChild(again);
    }
    again.hidden = false;
    again.onclick = () => { again.hidden = true; loadAccount(group, status); };
  }
  async function openAccount(id, btn) {
    setBusy(btn, true);
    try {
      const data = await requestJSON('auth/projects/' + encodeURIComponent(id));
      if (!data || !data.proj || !root.Projects) throw new Error('load');
      if (root.app && root.app.flushAutosave && !root.app.flushAutosave()) { setBusy(btn, false); return; }
      const saved = new root.Projects.ProjectStore().adoptAccount(data.proj);
      if (root.app && root.app.openProject && !root.app.openProject(saved.id)) { setBusy(btn, false); return; }
      const dlg = document.getElementById('projDlg');
      if (dlg) dlg.hidden = true;
    } catch (e) {
      setBusy(btn, false);
      if (e.status === 401 || e.status === 403) await refreshSession();
      toast("Couldn't open that project. Try again.", true);
    }
  }
  async function loadAccount(group, status) {
    const old = group.querySelector('.auth-account');
    if (old) old.remove();
    status.textContent = 'Loading projects saved to your account.';
    let data;
    try {
      data = await requestJSON('auth/projects');
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        await refreshSession();
        toast('Your sign-in changed. Check the account and sign in again if needed.', true);
      } else showAccountError(group, status);
      return;
    }
    if (!Array.isArray(data.projects)) { showAccountError(group, status); return; }
    const rows = data.projects;
    if (!rows.length) {
      status.textContent = 'No projects saved to your account yet.';
      return;
    }
    status.textContent = '';
    const list = document.createElement('ul');
    list.className = 'auth-account';
    rows.forEach((row) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = row.name || 'Untitled';
      const when = document.createElement('span');
      when.className = 'muted';
      when.textContent = accountWhen(row.updated);
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.setAttribute('aria-label', 'Open ' + (row.name || 'Untitled'));
      open.addEventListener('click', () => openAccount(row.id, open));
      li.append(name, when, open);
      list.appendChild(li);
    });
    group.appendChild(list);
  }
  function fillProjects(dialog) {
    const box = dialog && dialog.querySelector('#authProj');
    if (!box) return;
    box.textContent = '';
    if (!session && authStatus !== 'error') return;
    if (session && session.signed_in) {
      const group = document.createElement('section');
      group.id = 'authAccount';
      group.setAttribute('aria-labelledby', 'authAccountTitle');
      const title = document.createElement('h4');
      title.id = 'authAccountTitle';
      title.textContent = 'In your account';
      const status = document.createElement('p');
      status.id = 'authAccountStatus';
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const identity = document.createElement('p'); identity.className = 'auth-note';
      identity.textContent = 'Signed in as ' + (session.display_name || 'your account') + ' with ' + brandName(session.provider) + '.';
      const help = document.createElement('p'); help.className = 'auth-note';
      help.textContent = 'Changes are saved on this device. Save to account creates a version you can open on another device; earlier versions are kept.';
      const save = document.createElement('button'); save.type = 'button'; save.id = 'authAccountSave';
      save.textContent = 'Save current project to account'; save.disabled = !(root.app && root.app.proj);
      const saveStatus = document.createElement('p'); saveStatus.id = 'authAccountSaveStatus'; saveStatus.className = 'auth-message';
      saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite');
      if (lastAccountSave && root.app && root.app.proj && lastAccountSave.id === root.app.proj.id) {
        saveStatus.textContent = accountWhen(lastAccountSave.at) + ' to this account. Later edits stay local until you save to account again.';
      }
      save.onclick = () => saveCurrentProject();
      group.append(title, identity, help, save, saveStatus, status);
      box.appendChild(group);
      loadAccount(group, status);
      return;
    }
    if (!providerList().length && authStatus !== 'error') return;
    const note = document.createElement('p');
    note.className = 'auth-note';
    note.id = 'authProjNote';
    note.textContent = authStatus === 'error' ? 'The account service is unavailable. Your local projects are still here.'
      : 'Sign in to save versions of your projects to your account.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-go';
    btn.textContent = 'Sign in';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openWindow({ opener: btn });
    });
    box.append(note, btn);
  }
  function signOutCancelled(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    const msg = String(err.message || err);
    return /aborted|abort|cancelled|canceled|NS_BINDING_ABORTED/i.test(msg);
  }
  async function signOut(btn) {
    if (!session || !session.csrf) return;
    if (!preserveWork()) return;
    setBusy(btn, true);
    try {
      const res = await fetch(here('auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf },
        body: JSON.stringify({ csrf: session.csrf }),
      });
      if (!res.ok) {
        setBusy(btn, false);
        toast('Sign-out needs a fresh page. Reload and try again.', true);
        return;
      }
      try { await res.json(); }
      catch (e) { if (signOutCancelled(e)) return; }
      setImportMark('');
      rememberEmail(null);
      location.reload();
    } catch (e) {
      if (signOutCancelled(e)) return;
      setBusy(btn, false);
      toast('Sign-out needs a fresh page. Reload and try again.', true);
    }
  }
  function saveQuestion(n) {
    return 'Save your ' + n + (n === 1 ? ' project' : ' projects') + ' to your account?';
  }
  function saveResultMessage(result) {
    const saved = result.imported + result.unchanged;
    const text = result.imported ? savedSentence(result.imported) : saved + (saved === 1 ? ' project is already saved to your account' : ' projects are already saved to your account');
    return text + (result.last_saved ? '. ' + accountWhen(result.last_saved) + '.' : '.');
  }
  function partialSaveMessage(result) {
    const saved = result.imported + result.unchanged;
    const names = result.rejected.slice(0, 3).map((item) => item.name || 'Untitled').join(', ');
    const reasons = new Set(result.rejected.map((item) => item.reason));
    let text = saved ? saved + ' saved or already in your account. ' : '';
    text += "Couldn't save " + names + (result.rejected.length > 3 ? ' and other projects' : '') + '. ';
    if (reasons.has('project_too_large')) text += 'An account project must fit the account size limit. Download its JSON to keep a backup. ';
    if (reasons.has('account_full')) text += 'Your account has reached its saved-version limit. Download a JSON backup. ';
    if (reasons.has('snapshot_conflict')) text += 'Duplicate the affected local project before saving it again. ';
    if (reasons.has('invalid_project')) text += 'Check that the affected project is valid. ';
    return text + 'All originals remain on this device.';
  }
  async function uploadSnapshots(projects, signal, progress) {
    if (!session || !session.signed_in || !session.csrf) throw new AuthError('Sign in before saving to your account.', 401);
    const csrf = session.csrf;
    const limits = session.limits || { import_batch: 40, import_bytes: 1000000 };
    if (!Number.isInteger(limits.import_batch) || limits.import_batch < 1 || limits.import_batch > 40
        || !Number.isInteger(limits.import_bytes) || limits.import_bytes < 1024) {
      throw new AuthError('The account service returned invalid save limits. Try again after reloading.');
    }
    const result = { imported: 0, unchanged: 0, rejected: [], last_saved: 0 };
    const encoder = new TextEncoder();
    const overhead = encoder.encode(JSON.stringify({ csrf, projects: [] })).length;
    const batches = [];
    let batch = [], size = overhead;
    for (const project of projects) {
      const bytes = encoder.encode(JSON.stringify(project)).length;
      if (bytes + overhead > limits.import_bytes) {
        result.rejected.push({ id: project.id, name: project.name, reason: 'project_too_large' });
        continue;
      }
      if (batch.length && (batch.length >= limits.import_batch || size + bytes + 1 > limits.import_bytes)) {
        batches.push(batch); batch = []; size = overhead;
      }
      size += bytes + (batch.length ? 1 : 0); batch.push(project);
    }
    if (batch.length) batches.push(batch);
    for (const items of batches) {
      let data;
      try {
        data = await requestJSON('auth/projects/import', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ csrf, projects: items }), signal,
        });
      } catch (error) {
        if (error.data && Array.isArray(error.data.rejected)) data = error.data;
        else {
          if (error.status === 401 || error.status === 403) {
            await refreshSession();
            error.message = 'Your sign-in changed. Check the account before saving again. Your projects remain on this device.';
          }
          const completed = result.imported + result.unchanged;
          if (completed) error.message = completed + ' projects were confirmed saved. ' + error.message;
          throw error;
        }
      }
      if (!Number.isInteger(data.imported) || data.imported < 0 || !Number.isInteger(data.unchanged) || data.unchanged < 0
          || !Array.isArray(data.rejected) || data.imported + data.unchanged + data.rejected.length !== items.length
          || !data.rejected.every((item) => item && typeof item.reason === 'string' && typeof item.name === 'string')
          || data.ok !== (data.rejected.length === 0) || !Number.isFinite(data.last_saved)) {
        throw new AuthError('The account service returned an incomplete save result. Your projects remain on this device.');
      }
      result.imported += data.imported; result.unchanged += data.unchanged;
      result.rejected.push(...data.rejected); result.last_saved = Math.max(result.last_saved, data.last_saved);
      if (progress) progress(result.imported + result.unchanged, projects.length);
    }
    return result;
  }
  async function saveCurrentProject() {
    if (!session || !session.signed_in) { openWindow({ opener: document.activeElement }); return false; }
    if (!root.app || !root.app.proj) { toast('Open a project before saving to your account.', true); return false; }
    if (!root.app.cmd.save()) return false;
    if (!document.getElementById('projDlg') || document.getElementById('projDlg').hidden) root.app.cmd.projects();
    const button = document.getElementById('authAccountSave');
    const status = document.getElementById('authAccountSaveStatus');
    if (!button || !status) { toast('Account controls are not ready. Reopen My Projects and try again.', true); return false; }
    if (button.disabled) return false;
    const project = new root.Projects.ProjectStore().snapshot().find((item) => item.id === root.app.proj.id);
    if (!project) { message(status, 'Save the project locally before saving it to your account.', true); return false; }
    setBusy(button, true); button.textContent = 'Saving to account...';
    message(status, 'Saving a version of ' + project.name + ' to your account...');
    try {
      const result = await uploadSnapshots([project]);
      if (result.rejected.length) throw new AuthError(partialSaveMessage(result));
      lastAccountSave = { id: project.id, at: result.last_saved };
      message(status, saveResultMessage(result) + ' Later edits stay local until you save to account again.');
      notifyState();
      const group = document.getElementById('authAccount');
      if (group) loadAccount(group, document.getElementById('authAccountStatus'));
      return true;
    } catch (error) {
      const currentStatus = document.getElementById('authAccountSaveStatus');
      const text = error.message + (error.retryAfter ? ' Try again in ' + Math.ceil(error.retryAfter) + ' seconds.' : '');
      if (currentStatus) message(currentStatus, text, true);
      else toast(text, true);
      return false;
    } finally {
      setBusy(button, false); button.textContent = 'Save current project to account';
    }
  }
  function askSave(projects) {
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.className = 'modal';
      d.id = 'authSaveDlg';
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'authSaveTitle');
      const title = document.createElement('h3');
      title.id = 'authSaveTitle';
      title.textContent = saveQuestion(projects.length);
      const target = session.csrf;
      const description = document.createElement('p'); description.id = 'authSaveDescription'; description.className = 'auth-note';
      description.textContent = 'Save versions to ' + (session.display_name || 'your account') + ' with ' + brandName(session.provider) + '. Originals remain on this device.';
      box.setAttribute('aria-describedby', description.id);
      const status = document.createElement('p'); status.id = 'authSaveStatus'; status.className = 'auth-message'; status.setAttribute('aria-live', 'polite');
      const row = document.createElement('div');
      row.className = 'row';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.id = 'authSaveYes';
      yes.textContent = 'Save';
      const no = document.createElement('button');
      no.type = 'button';
      no.id = 'authSaveNo';
      no.textContent = 'Not now';
      row.append(yes, no);
      box.append(title, description, status, row);
      d.appendChild(box);
      document.body.appendChild(d);
      let done = false, controller = null;
      const before = document.activeElement;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (controller) {
          controller.abort();
          if (!save) toast('Saving stopped. Some versions may already be in your account; all originals remain on this device.');
        }
        window.removeEventListener('keydown', onKey, true);
        d.remove();
        focusBack(before);
        resolve(!!save);
      };
      const buttons = () => [yes, no].filter((button) => !button.disabled);
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          finish(false);
          return;
        }
        if (e.key !== 'Tab') return;
        const list = buttons();
        const i = list.indexOf(document.activeElement);
        e.preventDefault();
        if (e.shiftKey) list[i <= 0 ? list.length - 1 : i - 1].focus();
        else list[(i + 1) % list.length].focus();
      }
      window.addEventListener('keydown', onKey, true);
      yes.addEventListener('click', async () => {
        if (controller) return;
        if (!session || !session.signed_in || session.csrf !== target) {
          message(status, 'The signed-in account changed. Close this prompt and choose Save to account again.', true);
          yes.disabled = true; no.textContent = 'Close'; no.focus(); return;
        }
        controller = new AbortController(); setBusy(yes, true); yes.textContent = 'Saving...'; no.textContent = 'Stop saving'; no.focus();
        message(status, 'Saving the selected project versions...');
        try {
          const result = await uploadSnapshots(projects, controller.signal,
            (saved, total) => { if (!done) message(status, saved + ' of ' + total + ' projects confirmed saved.'); });
          if (done) return;
          if (result.rejected.length) throw new AuthError(partialSaveMessage(result));
          controller = null;
          toast(saveResultMessage(result));
          finish(true);
        } catch (error) {
          if (!done && !error.cancelled) message(status, error.message + (error.retryAfter ? ' Try again in ' + Math.ceil(error.retryAfter) + ' seconds.' : ''), true);
        } finally {
          controller = null;
          if (!done) { setBusy(yes, false); yes.textContent = 'Try again'; no.textContent = 'Not now'; yes.focus(); }
        }
      });
      no.addEventListener('click', () => finish(false));
      d.addEventListener('mousedown', (e) => { if (e.target === d) e.preventDefault(); });
      d.addEventListener('click', (e) => { if (e.target === d) finish(false); });
      no.focus();
    });
  }
  async function importLocal() {
    if (!session || !session.signed_in || !session.csrf || !root.Projects) return;
    if (!preserveWork()) return;
    let projects = [];
    try { projects = new root.Projects.ProjectStore().snapshot(); }
    catch (e) { toast("Couldn't read the local projects. Open My Projects and use Save to account to try again.", true); return; }
    if (!projects.length) return;
    if (importMark() === session.csrf) return;
    const target = session.csrf;
    await askSave(projects);
    if (session && session.csrf === target) setImportMark(target);
  }
  function strip(name) {
    const sp = new URLSearchParams(location.search);
    if (!sp.has(name)) return '';
    const value = sp.get(name);
    sp.delete(name);
    try {
      history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash);
    } catch (e) { /* the address bar can stay */ }
    return value;
  }
  function continueSignIn() {
    const which = strip('signin');
    if (which !== 'google' && which !== 'github') return;
    if (!session || session.signed_in || !session.providers || !session.providers[which]) return;
    const url = here('auth/' + which);
    url.searchParams.set('next', returnTarget());
    location.assign(url.href);
  }
  function mount() {
    mountHeader();
    mountMobile();
    notifyState();
    const sign = document.getElementById('authDlg');
    if (session.signed_in) {
      rememberEmail(null);
      if (sign && !sign.hidden) closeWindow();
    } else {
      if (!session.providers.email) rememberEmail(null);
      if (sign && !sign.hidden) renderWindow();
    }
    const projects = document.getElementById('projDlg');
    if (projects && !projects.hidden) fillProjects(projects);
    const flag = strip('auth_error');
    if (flag === 'cancelled') toast(CANCELLED);
    if (session.signed_in && flag === 'ok') importLocal().catch((error) => toast(error.message, true));
    continueSignIn();
  }
  function authOn() {
    const meta = document.querySelector('meta[name="cl-auth"]');
    return !!(meta && meta.getAttribute('content') === '1');
  }
  function refreshSession() {
    if (typeof document === 'undefined' || !authOn()) return Promise.resolve(false);
    if (sessionRequest) return sessionRequest;
    authStatus = 'loading';
    mountHeader(); mountMobile(); notifyState();
    const dialog = document.getElementById('authDlg');
    if (dialog && !dialog.hidden) renderWindow();
    sessionRequest = requestJSON('auth/session')
      .then((data) => {
        if (!data.providers || typeof data.providers !== 'object') throw new AuthError('Sign-in options could not be loaded.');
        if (!session || session.csrf !== data.csrf) lastAccountSave = null;
        session = data;
        authStatus = 'ready'; authFailure = null;
        if (root.GuestParts && typeof root.GuestParts.noteSession === 'function') root.GuestParts.noteSession(session);
        mount();
      })
      .catch((error) => {
        session = null; authStatus = 'error'; authFailure = error; lastAccountSave = null;
        if (root.GuestParts && typeof root.GuestParts.noteSession === 'function') root.GuestParts.noteSession(null);
        mountHeader(); mountMobile(); notifyState();
        const dlg = document.getElementById('authDlg');
        if (dlg && !dlg.hidden) renderWindow();
        const projects = document.getElementById('projDlg');
        if (projects && !projects.hidden) fillProjects(projects);
      })
      .finally(() => { sessionRequest = null; });
    return sessionRequest;
  }
  function boot() {
    if (!authOn()) return;
    refreshSession();
  }
  function useSession(next) {
    session = next;
    authStatus = next ? 'ready' : 'idle';
    if (root.GuestParts && typeof root.GuestParts.noteSession === 'function') root.GuestParts.noteSession(session);
    notifyState();
  }
  const api = {
    fillProjects: fillProjects,
    mountMobile: mountMobile,
    begin: begin,
    here: here,
    openMenu: openMenu,
    openWindow: openWindow,
    closeWindow: closeWindow,
    returnTarget: returnTarget,
    signOutCancelled: signOutCancelled,
    useSession: useSession,
    getState: getState,
    retry: refreshSession,
    saveCurrentProject: saveCurrentProject,
    signOut: signOut,
  };
  root.clAuth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
