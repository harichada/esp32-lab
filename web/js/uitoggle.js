/* Visible on every interface. Studio Dark is opt-in and remembered in esp32lab.ui. */
(function () {
  const KEY = 'esp32lab.ui';
  function remember(value) {
    try { clStorage.local.setItem(KEY, value); } catch (e) { /* the address still changes */ }
  }
  function go(mode) {
    const url = new URL(location.href);
    if (mode === '3') {
      remember('3');
      url.searchParams.set('ui', '3');
    } else {
      remember('1');
      url.searchParams.delete('ui');
    }
    location.assign(url.toString());
  }
  function place(btn) {
    const ui3 = document.documentElement.getAttribute('data-ui') === '3';
    const slot = document.getElementById('ui3SwitchSlot');
    if (ui3 && slot) {
      if (btn.parentNode !== slot) slot.appendChild(btn);
      return;
    }
    const main = document.getElementById('main') || document.body;
    if (btn.parentNode !== main) main.appendChild(btn);
  }
  function boot() {
    let btn = document.getElementById('uiSwitch');
    if (!btn) {
      const ui3 = document.documentElement.getAttribute('data-ui') === '3';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'uiSwitch';
      btn.className = 'ui-switch';
      btn.textContent = ui3 ? 'Switch back' : 'Try the new interface';
      btn.setAttribute('aria-label', ui3 ? 'Switch back to the current interface' : 'Try the new interface');
      btn.addEventListener('click', () => go(ui3 ? '1' : '3'));
    }
    place(btn);
    window.__placeUiSwitch = () => place(btn);
    if (!btn.dataset.watched) {
      btn.dataset.watched = '1';
      new MutationObserver(() => place(btn)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
