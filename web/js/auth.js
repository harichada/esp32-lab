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
  function here(path) {
    return new URL(path, location.href);
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
  function onIpOrigin() {
    return location.protocol === 'http:' && /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname);
  }
  function needsHandoff() {
    const target = session && session.https_origin;
    if (!target || !onIpOrigin()) return false;
    try { return new URL(target).origin !== location.origin; } catch (e) { return false; }
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
    ['auth_error', 'signin', 'moved', 't'].forEach((k) => sp.delete(k));
    const view = viewName();
    if (view && view !== '2d') sp.set('view', view);
    else sp.delete('view');
    const q = sp.toString();
    return path + (q ? '?' + q : '');
  }
  function ensureMigrate() {
    if (root.clMigrate) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/migrate.js?v=1';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('move'));
      document.head.appendChild(s);
    });
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
      if (needsHandoff()) {
        await ensureMigrate();
        const sp = new URLSearchParams(location.search);
        ['auth_error', 'moved', 't'].forEach((k) => sp.delete(k));
        sp.set('signin', provider);
        const view = viewName();
        if (view && view !== '2d') sp.set('view', view);
        await root.clMigrate.handoff({
          target: String(session.https_origin).replace(/\/$/, ''),
          path: location.pathname || '/',
          query: sp.toString(),
        });
        return;
      }
      const url = here('auth/' + provider);
      url.searchParams.set('next', returnTarget());
      location.assign(url.href);
    } catch (e) {
      setBusy(btn, false);
      toast('Sign-in could not be started. Your work is still on this device.', true);
    }
  }
  function menuButtons() {
    const providers = (session && session.providers) || {};
    const out = [];
    if (providers.google) out.push(['google', 'Google']);
    if (providers.github) out.push(['github', 'GitHub']);
    return out;
  }
  function closeMenu() {
    const menu = $('#authMenu');
    const btn = $('#bSignIn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
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
      const choices = menuButtons();
      if (!choices.length) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'bSignIn';
      btn.textContent = 'Sign in';
      btn.setAttribute('aria-haspopup', choices.length > 1 ? 'menu' : 'false');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', 'authMenu');
      const menu = document.createElement('div');
      menu.id = 'authMenu';
      menu.className = 'auth-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      choices.forEach(([id, label]) => {
        const item = providerButton(id, 'Sign in with ' + label);
        item.setAttribute('role', 'menuitem');
        menu.appendChild(item);
      });
      btn.addEventListener('click', () => {
        if (choices.length === 1) { begin(choices[0][0], btn); return; }
        const open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          const first = menu.querySelector('button');
          if (first) first.focus();
        }
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && choices.length > 1) {
          e.preventDefault();
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          const first = menu.querySelector('button');
          if (first) first.focus();
        }
      });
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      document.addEventListener('click', (e) => {
        if (!slot.contains(e.target)) closeMenu();
      });
      slot.append(btn, menu);
    }
    const dot = $('#connDot');
    if (dot) tb.insertBefore(slot, dot);
    else tb.appendChild(slot);
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
    const label = document.createElement('div');
    label.className = 'm-lbl';
    label.textContent = 'Account';
    const list = document.createElement('div');
    list.className = 'm-list';
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
      list.appendChild(out);
      box.append(label, name, list);
      return;
    }
    const choices = menuButtons();
    if (!choices.length) { box.remove(); return; }
    choices.forEach(([id, text]) => {
      const b = providerButton(id, 'Sign in with ' + text);
      b.id = choices.length === 1 ? 'mSignIn' : '';
      if (!b.id) b.id = 'mSignIn' + text;
      list.appendChild(b);
    });
    if (choices.length === 1) list.querySelector('button').id = 'mSignIn';
    box.append(label, list);
  }
  function fillProjects(dialog) {
    const box = dialog && dialog.querySelector('#authProj');
    if (!box) return;
    box.textContent = '';
    if (!session) return;
    if (session.signed_in) {
      const p = document.createElement('p');
      p.className = 'auth-note';
      p.append('Signed in as ');
      const b = document.createElement('b');
      b.textContent = session.display_name || 'Signed in';
      p.append(b);
      box.appendChild(p);
      return;
    }
    const choices = menuButtons();
    if (!choices.length) return;
    const note = document.createElement('p');
    note.className = 'auth-note';
    note.id = 'authProjNote';
    note.textContent = 'Sign in to keep your projects on any device.';
    const group = document.createElement('div');
    group.className = 'auth-provs';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', 'authProjNote');
    choices.forEach(([id, text]) => group.appendChild(providerButton(id, 'Sign in with ' + text)));
    box.append(note, group);
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
      setImportMark('');
      location.reload();
    } catch (e) {
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
    if (needsHandoff()) return;
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
        mount();
      })
      .catch(() => { /* the lab keeps working with no account */ });
  }
  const api = {
    fillProjects: fillProjects,
    mountMobile: mountMobile,
    begin: begin,
    returnTarget: returnTarget,
  };
  root.clAuth = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
