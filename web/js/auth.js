/* Sign-in. With the flag off the page has no cl-auth meta, and this file
   does not request /auth/session. The lab, examples, Run, and a local save
   never wait on an account, and sign-in never uploads guest projects. */
(function (root) {
  const CANCELLED = 'Sign-in cancelled — your work is still here';
  let session = null;

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function toast(msg, err) {
    if (root.app && root.app.cmd && root.app.cmd.toast) root.app.cmd.toast(msg, !!err);
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
  const BRANDS = { google: 'Google', github: 'GitHub', facebook: 'Facebook', x: 'X', twitter: 'X' };
  const BRAND_ORDER = ['google', 'github', 'facebook', 'x', 'twitter'];
  const LEAD = 'Sign in to unlock all parts and save projects to your account. Your work on this device stays here.';
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
    return [...box.querySelectorAll('button, a[href], input, select, textarea')].filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
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
    const back = opener && opener.isConnected ? opener : sign;
    opener = null;
    if (back && typeof back.focus === 'function') {
      try { back.focus(); } catch (e) { /* the opener may be in a closed sheet */ }
    }
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
    if (!session || session.signed_in) return false;
    const choices = providerList();
    if (!choices.length) return false;
    const dlg = ensureWindow();
    const title = document.getElementById('authDlgTitle');
    const part = document.getElementById('authDlgPart');
    const line = partLine(opts && opts.part);
    title.textContent = 'Sign in';
    if (line) {
      part.hidden = false;
      part.textContent = line;
    } else if (part) {
      part.hidden = true;
      part.textContent = '';
    }
    const list = document.getElementById('authDlgChoices');
    list.textContent = '';
    choices.forEach(([id, brand]) => {
      const b = providerButton(id, 'Continue with ' + brand);
      b.classList.add('auth-brand');
      b.insertBefore(brandMark(id, brand), b.firstChild);
      list.appendChild(b);
    });
    const from = (opts && opts.opener) || document.activeElement;
    opener = from && from !== document.body ? from : document.getElementById('bSignIn');
    const sign = document.getElementById('bSignIn');
    if (sign) sign.setAttribute('aria-expanded', 'true');
    dlg.hidden = false;
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
    const first = list.querySelector('button') || document.getElementById('authDlgClose');
    if (first) first.focus();
    return true;
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
  }
  async function begin(provider, btn) {
    if (!session || session.signed_in) return;
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
    if (!tb || $('#authSlot')) return;
    const slot = document.createElement('div');
    slot.id = 'authSlot';
    slot.className = 'auth-slot';
    if (session.signed_in) {
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
      if (!providerList().length) return;
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
    if (!more || !session) return;
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
    if (session.signed_in) {
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
    if (!providerList().length) { box.remove(); return; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mSignIn';
    btn.textContent = 'Sign in';
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
      const res = await fetch(here('auth/projects/' + encodeURIComponent(id)), {
        credentials: 'same-origin', headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('load');
      const data = await res.json();
      if (!data || !data.proj || !root.Projects) throw new Error('load');
      const saved = new root.Projects.ProjectStore().adoptAccount(data.proj);
      const dlg = document.getElementById('projDlg');
      if (dlg) dlg.hidden = true;
      if (root.app && root.app.openProject) root.app.openProject(saved.id);
    } catch (e) {
      setBusy(btn, false);
      toast("Couldn't open that project. Try again.", true);
    }
  }
  async function loadAccount(group, status) {
    const old = group.querySelector('.auth-account');
    if (old) old.remove();
    status.textContent = 'Loading projects saved to your account.';
    let res;
    try {
      res = await fetch(here('auth/projects'), {
        credentials: 'same-origin', headers: { accept: 'application/json' },
      });
    } catch (e) { showAccountError(group, status); return; }
    if (res.status === 401) {
      status.textContent = 'Sign in to see the projects in your account.';
      return;
    }
    if (!res.ok) { showAccountError(group, status); return; }
    let data = {};
    try { data = await res.json(); } catch (e) { showAccountError(group, status); return; }
    const rows = Array.isArray(data.projects) ? data.projects : [];
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
    if (!session) return;
    if (session.signed_in) {
      const group = document.createElement('section');
      group.id = 'authAccount';
      group.setAttribute('aria-labelledby', 'authAccountTitle');
      const title = document.createElement('h4');
      title.id = 'authAccountTitle';
      title.textContent = 'In your account';
      const status = document.createElement('p');
      status.id = 'authAccountStatus';
      group.append(title, status);
      box.appendChild(group);
      loadAccount(group, status);
      return;
    }
    if (!providerList().length) return;
    const note = document.createElement('p');
    note.className = 'auth-note';
    note.id = 'authProjNote';
    note.textContent = 'Sign in to keep your projects on any device.';
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
  function askSave(n) {
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
      title.textContent = saveQuestion(n);
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
      box.append(title, row);
      d.appendChild(box);
      document.body.appendChild(d);
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        d.remove();
        resolve(!!save);
      };
      const buttons = () => [yes, no];
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
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
      d.addEventListener('mousedown', (e) => { if (e.target === d) e.preventDefault(); });
      d.addEventListener('click', (e) => { if (e.target === d) finish(false); });
      no.focus();
    });
  }
  async function importLocal() {
    if (!session || !session.signed_in || !session.csrf || !root.Projects) return;
    let projects = [];
    try { projects = new root.Projects.ProjectStore().snapshot(); } catch (e) { return; }
    if (!projects.length) return;
    if (importMark() === session.csrf) return;
    const save = await askSave(projects.length);
    if (!save) {
      setImportMark(session.csrf);
      return;
    }
    const res = await fetch(here('auth/projects/import'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf },
      body: JSON.stringify({ csrf: session.csrf, projects: projects }),
    });
    if (!res.ok) return;
    let data = {};
    try { data = await res.json(); } catch (e) { return; }
    setImportMark(session.csrf);
    if (data.imported > 0) toast(savedSentence(data.imported));
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
    const flag = strip('auth_error');
    if (flag === 'cancelled') toast(CANCELLED);
    if (session.signed_in && flag === 'ok') importLocal();
    continueSignIn();
  }
  function authOn() {
    const meta = document.querySelector('meta[name="cl-auth"]');
    return !!(meta && meta.getAttribute('content') === '1');
  }
  function boot() {
    if (!authOn()) return;
    fetch(here('auth/session'), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.providers) return;
        session = data;
        if (root.GuestParts && typeof root.GuestParts.noteSession === 'function') root.GuestParts.noteSession(session);
        mount();
      })
      .catch(() => { /* the lab keeps working with no account */ });
  }
  function useSession(next) {
    session = next;
    if (root.GuestParts && typeof root.GuestParts.noteSession === 'function') root.GuestParts.noteSession(session);
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
  };
  root.clAuth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
