try {
  const t = clStorage.local.getItem('esp32lab.theme');
  if (t) document.documentElement.dataset.theme = t;
} catch (e) { /* keep the default theme */ }
