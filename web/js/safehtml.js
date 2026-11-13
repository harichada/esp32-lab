/* HTML for project data. Every untrusted string goes through esc() before it is concatenated. */
(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fileTabsHtml(names, current, sketchLabel) {
    const tabs = (names || []).map((n) => {
      const label = n === 'sketch' ? sketchLabel : n;
      return `<button type="button" data-f="${esc(n)}" class="${n === current ? 'on' : ''}">${esc(label)}</button>`;
    }).join('');
    return tabs + '<button type="button" data-f="+" title="Add a header/source file" aria-label="Add a header or source file">＋</button>';
  }
  function warnListHtml(items) {
    if (!items || !items.length) return 'none';
    return items.map((x) => `<div class="w">⚠ ${x && x.id ? '<b>' + esc(x.id) + '</b>: ' : ''}${esc(x && x.msg)}</div>`).join('');
  }
  function warnBoxHtml(items) {
    return (items || []).slice(0, 4).map((x) => `⚠ ${esc(x && x.id || '')} ${esc(x && x.msg)}`).join('<br>');
  }
  function partTitleHtml(label, id) {
    return `<h3>${esc(label)} <small>${esc(id)}</small></h3>`;
  }
  function wireTitleHtml(id) {
    return `<h3>Wire ${esc(id)}</h3>`;
  }
  function rangeShown(field, value) {
    const n = +value;
    if (typeof value === 'number') {
      if (!Number.isFinite(n)) return '';
      if (field && field.log) return n > 0 ? String(Math.log10(n)) : '';
      return String(n);
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(n)) {
      if (field && field.log) return n > 0 ? String(Math.log10(n)) : '';
      return String(n);
    }
    return String(value == null ? '' : value);
  }
  function rangeControlHtml(field, value) {
    const e = field || {};
    const min = e.log ? Math.log10(e.min) : e.min;
    const max = e.log ? Math.log10(e.max) : e.max;
    const step = e.log ? 0.01 : e.step;
    return `<label>${esc(e.label)}<input type="range" data-k="${esc(e.k)}" min="${esc(min)}" max="${esc(max)}" step="${esc(step)}" value="${esc(rangeShown(e, value))}" data-log="${e.log ? '1' : ''}"></label>`;
  }
  const api = { esc, fileTabsHtml, warnListHtml, warnBoxHtml, partTitleHtml, wireTitleHtml, rangeControlHtml, rangeShown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SafeHtml = api;
})(typeof window !== 'undefined' ? window : globalThis);
