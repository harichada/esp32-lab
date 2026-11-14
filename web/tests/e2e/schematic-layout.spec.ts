// Like-breadboard schematic. Static files only: /api and the run socket are mocked.
// Blink, the Wi-Fi/IR remote, and Simon (a crowded board) at 390 and 1280.
import { test, expect, type Page } from '@playwright/test';

const EXAMPLES = [
  { id: 'blink', part: 'R1' },
  { id: 'remote', part: 'R1' },
  { id: 'simon', part: '' },
] as const;

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.routeWebSocket(/\/api\//, (ws) => {
    ws.onMessage(() => {});
  });
}

async function openExample(page: Page, id: string, width: number) {
  await page.setViewportSize({ width: width, height: width === 390 || width === 320 ? 844 : 800 });
  await page.goto('/?ex=' + id + '&resume=0');
  await page.waitForFunction((key) => {
    const app = (window as unknown as { app?: { proj?: { example?: string; parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.example === key && app.proj.parts && app.proj.parts.length && app.schematic);
  }, id);
  await page.locator('#bViewSch').click();
  await expect(page.locator('.toast')).not.toHaveCount(0);
  await page.waitForFunction(() => document.body.classList.contains('viewsch') && !!document.querySelector('#stageSch.on .sch-hit'));
  await expect.poll(async () => page.evaluate(() => {
    let w = 0;
    document.querySelectorAll('#stageSch .sch-hit').forEach((el) => { w = Math.max(w, el.getBoundingClientRect().width); });
    return w;
  })).toBeGreaterThan(8);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
  }));
  await chromeClear(page, id + '@' + width + ' while the toast is up');
}

type Box = { x: number; y: number; x2: number; y2: number; id: string; text: string };

async function drawing(page: Page) {
  return page.evaluate(() => {
    const model = (window as unknown as {
      app: { schematic: { model: {
        bounds: { x: number; y: number; w: number; h: number };
        symbols: { id: string; x: number; y: number; w: number; h: number }[];
        texts: { x: number; y: number; x2: number; y2: number; own: string | null; text: string; kind?: string; size?: number }[];
      } } };
    }).app.schematic.model;
    const bodies: Box[] = model.symbols.map((s) => ({ x: s.x, y: s.y, x2: s.x + s.w, y2: s.y + s.h, id: s.id, text: '' }));
    const labels: Box[] = (model.texts || []).map((t) => ({ x: t.x, y: t.y, x2: t.x2, y2: t.y2, id: t.own || '', text: t.text }));
    const screenBodies: Box[] = [];
    document.querySelectorAll('#stageSch .sch-hit').forEach((el) => {
      const r = el.getBoundingClientRect();
      const host = el.closest('.sch-sym');
      screenBodies.push({ x: r.left, y: r.top, x2: r.right, y2: r.bottom, id: (host && (host as HTMLElement).dataset.pid) || '', text: '' });
    });
    const toggle = document.getElementById('schLayout');
    const t = toggle ? toggle.getBoundingClientRect() : null;
    const buttons = [...document.querySelectorAll('#schLayout button')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        name: (el.textContent || '').trim(),
        label: el.getAttribute('aria-label') || '',
        w: r.width,
        h: r.height,
        pressed: el.getAttribute('aria-pressed'),
        disabled: (el as HTMLButtonElement).disabled,
      };
    });
    const svg = document.getElementById('stageSch') as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const box = svg.getBoundingClientRect();
    const zoom = vb.width > 0 ? box.width / vb.width : 0;
    let css = 1;
    const scale = (svg as SVGSVGElement & { currentScale?: number }).currentScale;
    if (scale && isFinite(scale) && scale > 0) css *= scale;
    const tr = getComputedStyle(svg).transform;
    const matrix = tr && tr.match(/matrix\(([^)]+)\)/);
    if (matrix) {
      const p = matrix[1].split(',').map((n) => Number(n));
      const sx = Math.hypot(p[0] || 0, p[1] || 0);
      if (sx > 0 && isFinite(sx)) css *= sx;
    }
    const partTexts = (model.texts || []).filter((text) => text.kind === 'ref' || text.kind === 'val' || text.kind === 'title');
    const font = partTexts.reduce((m, text) => Math.min(m, text.size || 11), Infinity);
    const b = model.bounds;
    const covers = vb.x <= b.x + 8 && vb.y <= b.y + 8 && vb.x + vb.width >= b.x + b.w - 8 && vb.y + vb.height >= b.y + b.h - 8;
    const fitAll = document.getElementById('schFitAll');
    const esp = (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.find((p) => p.type === 'esp32');
    const espEl = esp ? svg.querySelector('.sch-sym[data-pid="' + esp.id + '"] .sch-hit') : null;
    const er = espEl ? espEl.getBoundingClientRect() : null;
    const tools = document.querySelector('.canvas-tools');
    const trTools = tools ? tools.getBoundingClientRect() : null;
    const cx = er ? (er.left + er.right) / 2 : 0;
    const cy = er ? (er.top + er.bottom) / 2 : 0;
    const espInView = !!er && er.width > 4 && er.height > 4 && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
      && !(trTools && cx >= trTools.left && cx <= trTools.right && cy >= trTools.top && cy <= trTools.bottom);
    const edge = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { x: r.left, y: r.top, x2: r.right, y2: r.bottom };
    };
    const overlays = ['.zoom-tools', '.canvas-tools', '.hint', '.projbanner', 'header#top'].map(edge).filter((r): r is { x: number; y: number; x2: number; y2: number } => !!r);
    const meet = (a: { x: number; y: number; x2: number; y2: number }, b: { x: number; y: number; x2: number; y2: number }) =>
      Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
    const open = { left: box.left + 8, top: box.top + 8, right: box.right - 8, bottom: box.bottom - 8 };
    const wired = new Set((window as unknown as { Schematic: { openFrame: (m: unknown) => { ids: string[] } } }).Schematic.openFrame(model).ids);
    const outside: string[] = [];
    const partsOutside: string[] = [];
    const clipped: string[] = [];
    for (const body of screenBodies) {
      const inside = body.x >= open.left - 1 && body.y >= open.top - 1 && body.x2 <= open.right + 1 && body.y2 <= open.bottom + 1
        && !overlays.some((o) => meet(body, o));
      const meets = body.x2 > open.left && body.x < open.right && body.y2 > open.top && body.y < open.bottom;
      if (!inside) partsOutside.push(body.id);
      if (meets && !inside) clipped.push(body.id);
      if (wired.has(body.id) && !inside) outside.push(body.id);
    }
    return {
      bodies: bodies,
      labels: labels,
      screenBodies: screenBodies,
      toggle: t ? { x: t.left, y: t.top, x2: t.right, y2: t.bottom, w: t.width, h: t.height } : null,
      buttons: buttons,
      screenPx: (isFinite(font) ? font : 11) * zoom * css,
      zoomPct: zoom * 100,
      wiredOutside: outside,
      partsOutside: partsOutside,
      clipped: clipped,
      openTop: open.top,
      openBottom: open.bottom,
      covers: covers,
      fitAll: !!(fitAll && !fitAll.hidden),
      espInView: espInView,
      hidden: !!(toggle && toggle.hidden),
      innerH: window.innerHeight,
    };
  });
}

async function chromeClear(page: Page, where: string) {
  const boxes = await page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.left, y: r.top, x2: r.right, y2: r.bottom, id: '', text: '' };
    };
    return {
      toggle: rect(document.getElementById('schLayout')),
      hint: rect(document.querySelector('#stageWrap .hint')),
      toasts: [...document.querySelectorAll('.toast')].map((el) => rect(el)).filter((r): r is Box => !!r),
      symbols: [...document.querySelectorAll('#stageSch .sch-hit')].map((el) => rect(el)).filter((r): r is Box => !!r),
    };
  });
  expect(boxes.toggle, where + ' toggle').toBeTruthy();
  if (!boxes.toggle) return;
  if (boxes.hint) expect(overlaps(boxes.toggle, boxes.hint), where + ' hint ' + JSON.stringify(boxes.hint)).toBe(false);
  for (const toast of boxes.toasts) expect(overlaps(boxes.toggle, toast), where + ' toast ' + JSON.stringify(toast)).toBe(false);
  for (const symbol of boxes.symbols) expect(overlaps(boxes.toggle, symbol), where + ' symbol ' + JSON.stringify(symbol)).toBe(false);
}

async function visibleParts(page: Page) {
  return page.evaluate(() => {
    const hit = (a: { x: number; y: number; x2: number; y2: number }, b: { x: number; y: number; x2: number; y2: number }) =>
      Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
    const chrome = ['header#top', '.projbanner', '.hint', '.canvas-tools', '.zoom-tools'].map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { sel, x: r.left, y: r.top, x2: r.right, y2: r.bottom };
    }).filter((c): c is { sel: string; x: number; y: number; x2: number; y2: number } => !!c);
    const bad: string[] = [];
    document.querySelectorAll('#stageSch .sch-hit').forEach((el) => {
      const r = el.getBoundingClientRect();
      const id = ((el.closest('.sch-sym') as HTMLElement | null)?.dataset.pid) || '?';
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) bad.push(id + ' off');
      for (const c of chrome) if (hit({ x: r.left, y: r.top, x2: r.right, y2: r.bottom }, c)) bad.push(id + ' ' + c.sel);
    });
    return bad;
  });
}

function overlaps(a: Box, b: Box) {
  return Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 1;
}

async function labelAudit(page: Page) {
  return page.evaluate(() => {
    const hit = (a: { x: number; y: number; x2: number; y2: number }, b: { x: number; y: number; x2: number; y2: number }) =>
      Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
    const box = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) return null;
      return { x: r.left, y: r.top, x2: r.right, y2: r.bottom };
    };
    const svg = document.getElementById('stageSch') as SVGSVGElement | null;
    const ctm = svg && svg.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    const labels = [...document.querySelectorAll('#stageSch .sch-ref, #stageSch .sch-val, #stageSch .sch-title')].map((el) => {
      const b = box(el);
      const font = parseFloat(getComputedStyle(el).fontSize) || 0;
      return {
        text: (el.textContent || '').trim(),
        kind: (el as HTMLElement).dataset.kind || '',
        fontPx: font * scale,
        glyph: b ? b.y2 - b.y : 0,
        box: b,
        aria: ((el.closest('.sch-sym') as HTMLElement | null)?.getAttribute('aria-label')) || '',
      };
    }).filter((l) => l.box);
    let minFont = Infinity;
    let minGlyph = Infinity;
    const labelHits: string[] = [];
    for (let i = 0; i < labels.length; i++) {
      minFont = Math.min(minFont, labels[i].fontPx);
      minGlyph = Math.min(minGlyph, labels[i].glyph);
      for (let j = i + 1; j < labels.length; j++) {
        if (hit(labels[i].box!, labels[j].box!)) labelHits.push(labels[i].text + ' / ' + labels[j].text);
      }
    }
    const pins = [...document.querySelectorAll('#stageSch .sch-pin')].map(box).filter((b): b is NonNullable<typeof b> => !!b);
    // A straight wire's client rect is flat: the stroke lives outside it.
    const thick = Math.max(1.55 * scale, 1);
    const wires = [...document.querySelectorAll('#stageSch .sch-wire')].map((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - thick / 2, y: r.top - thick / 2, x2: r.right + thick / 2, y2: r.bottom + thick / 2 };
    }).filter((b): b is NonNullable<typeof b> => !!b && b.x2 - b.x > 0.5 && b.y2 - b.y > 0.5);
    const cover: string[] = [];
    for (const lab of labels) {
      if (pins.some((p) => hit(lab.box!, p))) cover.push(lab.text + ' pin');
      if (wires.some((w) => hit(lab.box!, w))) cover.push(lab.text + ' wire');
    }
    return {
      count: labels.length,
      minFont: isFinite(minFont) ? minFont : 0,
      minGlyph: isFinite(minGlyph) ? minGlyph : 0,
      labelHits: labelHits.slice(0, 8),
      cover: cover.slice(0, 8),
    };
  });
}

async function toolbarTops(page: Page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.canvas-tools button, .zoom-tools button')].filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && !(el as HTMLButtonElement).hidden;
    });
    const tops = buttons.map((el) => (el as HTMLElement).offsetTop);
    const heights = buttons.map((el) => el.getBoundingClientRect().height);
    return {
      n: buttons.length,
      tops,
      minH: heights.length ? Math.min(...heights) : 0,
      names: buttons.map((el) => ((el.textContent || el.id || '').trim()).slice(0, 24)),
    };
  });
}

function assertClear(report: Awaited<ReturnType<typeof drawing>>, where: string, mode: 'tidy' | 'board' = 'tidy') {
  expect(report.hidden, where + ' toggle').toBe(false);
  if (!report.fitAll) expect(report.covers, where + ' fitted').toBe(true);
  expect(report.buttons.map((b) => b.name), where).toEqual(['Breadboard', 'Tidy']);
  expect(report.buttons[0].label, where).toBe('Like breadboard');
  expect(report.buttons[1].label, where).toBe('Tidy arrangement');
  for (const b of report.buttons) {
    expect(b.w, where + ' ' + b.name).toBeGreaterThanOrEqual(44);
    expect(b.h, where + ' ' + b.name).toBeGreaterThanOrEqual(44);
    expect(b.disabled, where).toBe(false);
  }
  expect(report.buttons[0].pressed, where).toBe(mode === 'board' ? 'true' : 'false');
  expect(report.buttons[1].pressed, where).toBe(mode === 'tidy' ? 'true' : 'false');
  for (let i = 0; i < report.bodies.length; i++) for (let j = i + 1; j < report.bodies.length; j++) {
    expect(overlaps(report.bodies[i], report.bodies[j]), where + ' bodies ' + report.bodies[i].id + ' ' + report.bodies[j].id).toBe(false);
  }
  for (let i = 0; i < report.labels.length; i++) for (let j = i + 1; j < report.labels.length; j++) {
    expect(overlaps(report.labels[i], report.labels[j]), where + ' labels ' + report.labels[i].text + ' / ' + report.labels[j].text).toBe(false);
  }
  for (const label of report.labels) {
    for (const body of report.bodies) {
      if (label.id && label.id === body.id) continue;
      expect(overlaps(label, body), where + ' label ' + label.text + ' on ' + body.id).toBe(false);
    }
  }
  const toggle = report.toggle;
  expect(toggle, where + ' toggle box').toBeTruthy();
  if (!toggle) return;
  for (const body of report.screenBodies) expect(overlaps(body, toggle as Box), where + ' toggle covers ' + body.id).toBe(false);
}

for (const example of EXAMPLES) {
  for (const width of [390, 1280]) {
    test(example.id + ' schematic at ' + width, async ({ page }) => {
      await install(page);
      await openExample(page, example.id, width);
      const report = await drawing(page);
      assertClear(report, example.id + '@' + width);
      const seen = await visibleParts(page);
      expect(seen, example.id + '@' + width + ' part not fully visible ' + JSON.stringify(seen)).toEqual([]);
      if (example.id === 'blink' || example.id === 'simon') {
        expect(report.wiredOutside, example.id + '@' + width + ' off screen ' + JSON.stringify(report.wiredOutside)).toEqual([]);
      }
      const labels = await labelAudit(page);
      expect(labels.count, example.id + '@' + width + ' labels').toBeGreaterThan(0);
      expect(labels.minFont, example.id + '@' + width + ' label px ' + labels.minFont.toFixed(2)).toBeGreaterThanOrEqual(11);
      expect(labels.minGlyph, example.id + '@' + width + ' glyph ' + labels.minGlyph.toFixed(2)).toBeGreaterThanOrEqual(11);
      expect(labels.labelHits, example.id + '@' + width + ' label overlap').toEqual([]);
      expect(labels.cover, example.id + '@' + width + ' label on pin or wire').toEqual([]);
      if (width === 390 && report.toggle) {
        const mid = (report.toggle.y + report.toggle.y2) / 2;
        expect(mid, 'thumb reach').toBeGreaterThan(report.innerH * 0.55);
      }
      const part = example.part || await page.evaluate(() => {
        const p = (window as unknown as { app: { proj: { parts: { id: string; type: string }[] } } }).app.proj.parts.find((q) => q.type !== 'breadboard' && q.type !== 'label');
        return p ? p.id : '';
      });
      await page.locator('#schLayBoard').click();
      await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
      const before = await page.evaluate((id) => {
        const s = (window as unknown as { app: { schematic: { model: { symbols: { id: string; x: number; y: number }[] } } } }).app.schematic.model.symbols.find((s) => s.id === id);
        return s ? s.x + ',' + s.y : '';
      }, part);
      expect(before).not.toBe('');
      await page.locator('#bView2d').click();
      await page.waitForFunction(() => !document.body.classList.contains('viewsch'));
      await page.evaluate((id) => {
        const app = (window as unknown as { app: { proj: { parts: { id: string; x: number; y: number }[] }; editor: { render: () => void }; schematic: { invalidate: () => void } } }).app;
        const p = app.proj.parts.find((q) => q.id === id);
        if (!p) return;
        p.x += 80;
        p.y += 30;
        app.editor.render();
        app.schematic.invalidate();
      }, part);
      await page.locator('#bViewSch').click();
      await page.waitForFunction(() => document.body.classList.contains('viewsch'));
      await expect.poll(async () => page.evaluate((id) => {
        const s = (window as unknown as { app: { schematic: { model: { symbols: { id: string; x: number; y: number }[] } } } }).app.schematic.model.symbols.find((s) => s.id === id);
        return s ? s.x + ',' + s.y : '';
      }, part)).not.toBe(before);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
      }));
      const moved = await drawing(page);
      assertClear(moved, example.id + '@' + width + ' moved', 'board');
      if (example.id === 'blink' || example.id === 'simon') {
        expect(moved.wiredOutside, example.id + '@' + width + ' moved off screen').toEqual([]);
      }
      await expect(page.locator('.toast')).toHaveCount(0);
      await chromeClear(page, example.id + '@' + width + ' after the toast fades');
    });
  }
}

for (const width of [390, 768, 1280]) {
  test('schematic toolbar is one row at ' + width, async ({ page }) => {
    await install(page);
    await openExample(page, 'remote', width);
    const row = await toolbarTops(page);
    expect(row.n, width + ' buttons ' + JSON.stringify(row.names)).toBeGreaterThan(3);
    const top = row.tops[0];
    for (const t of row.tops) expect(t, width + ' offsetTop ' + JSON.stringify(row)).toBe(top);
    if (width === 390) expect(row.minH, width + ' touch height').toBeGreaterThanOrEqual(44);
    const fit = page.locator('#schFitAll');
    if (await fit.isVisible()) {
      const fitBox = await fit.boundingBox();
      const zoom = await page.locator('.zoom-tools').boundingBox();
      expect(fitBox && zoom && fitBox.x >= zoom.x - 1 && fitBox.x + fitBox.width <= zoom.x + zoom.width + 1).toBe(true);
    }
  });
}

async function safeAudit(page: Page) {
  return page.evaluate(() => {
    const hit = (a: { x: number; y: number; x2: number; y2: number }, b: { x: number; y: number; x2: number; y2: number }) =>
      Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
    const shown = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return r;
    };
    const canvas = document.getElementById('stageSch')!.getBoundingClientRect();
    const edge = 8;
    const bars = ['.canvas-tools', '.zoom-tools'].map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const r = shown(el);
      if (!el || !r) return { sel, scroll: 0, client: 0, ok: true };
      return { sel, scroll: el.scrollWidth, client: el.clientWidth, ok: el.scrollWidth <= el.clientWidth + 0.5 };
    });
    const buttons = [...document.querySelectorAll('.canvas-tools button, .zoom-tools button')].filter((el) => {
      const r = shown(el);
      return !!r && !(el as HTMLButtonElement).hidden;
    }).map((el) => {
      const r = el.getBoundingClientRect();
      const off = r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5;
      return { id: el.id || (el.textContent || '').trim(), off };
    });
    const overlays = ['.zoom-tools', '.canvas-tools', '.hint'].map((sel) => {
      const r = shown(document.querySelector(sel));
      return r ? { sel, x: r.left, y: r.top, x2: r.right, y2: r.bottom } : null;
    }).filter((b): b is { sel: string; x: number; y: number; x2: number; y2: number } => !!b);
    const bad: string[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    document.querySelectorAll('#stageSch .sch-hit, #stageSch .sch-ref, #stageSch .sch-val, #stageSch .sch-title, #stageSch .sch-flag, #stageSch .sch-gnd').forEach((el) => {
      if (!shown(el)) return;
      const r = el.getBoundingClientRect();
      const id = ((el.closest('.sch-sym') as HTMLElement | null)?.dataset.pid) || (el.textContent || el.className || '').toString().trim().slice(0, 24);
      const box = { x: r.left, y: r.top, x2: r.right, y2: r.bottom };
      if (r.left < canvas.left + edge - 0.5) bad.push(id + ' left ' + (r.left - canvas.left).toFixed(1));
      if (r.top < canvas.top + edge - 0.5) bad.push(id + ' top ' + (r.top - canvas.top).toFixed(1));
      if (r.right > canvas.right - edge + 0.5) bad.push(id + ' right ' + (canvas.right - r.right).toFixed(1));
      if (r.bottom > canvas.bottom - edge + 0.5) bad.push(id + ' bottom ' + (canvas.bottom - r.bottom).toFixed(1));
      for (const o of overlays) if (hit(box, o)) bad.push(id + ' ' + o.sel);
      minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
      n += 1;
    });
    const Pinch = (window as unknown as { Pinch: { frameOf: (el: Element) => { stage: { left: number; top: number; right: number; bottom: number; width: number; height: number }; blockers: unknown[] }; bestClear: (stage: unknown, blockers: unknown, bounds: unknown, gap: number, pad: number, limits: unknown) => { width: number; height: number } } }).Pinch;
    const model = (window as unknown as { app: { schematic: { model: { bounds: { w: number; h: number } } } } }).app.schematic.model;
    const svg = document.getElementById('stageSch')!;
    const frame = Pinch.frameOf(svg);
    const hole = Pinch.bestClear(frame.stage, frame.blockers, model.bounds, 12, 12, { min: 0.12, max: 2.4 });
    const contentW = n ? maxX - minX : 0;
    const contentH = n ? maxY - minY : 0;
    const limit = Math.max(contentW / Math.max(hole.width, 1), contentH / Math.max(hole.height, 1));
    const zoom = (document.getElementById('zoomPct')?.textContent || '').trim();
    return { bars, buttons: buttons.filter((b) => b.off), bad: bad.slice(0, 12), limit, zoom, n };
  });
}

for (const example of EXAMPLES) {
  for (const width of [320, 390, 1280]) {
    test(example.id + ' fits the safe area at ' + width, async ({ page }) => {
      await install(page);
      await openExample(page, example.id, width);
      const audit = await safeAudit(page);
      for (const bar of audit.bars) {
        expect(bar.ok, example.id + '@' + width + ' ' + bar.sel + ' ' + bar.scroll + ' in ' + bar.client).toBe(true);
      }
      expect(audit.buttons, example.id + '@' + width + ' toolbar off screen').toEqual([]);
      expect(audit.bad, example.id + '@' + width + ' outside the safe area').toEqual([]);
      expect(audit.n, example.id + '@' + width + ' parts').toBeGreaterThan(0);
      if (example.id === 'remote' && width === 1280) {
        expect(audit.limit, example.id + '@' + width + ' fill ' + audit.zoom + ' ' + audit.limit.toFixed(2)).toBeGreaterThanOrEqual(0.6);
      }
    });
  }
}

test('remote at 390 keeps labels readable and the whole sheet can be shown', async ({ page }) => {
  await install(page);
  await openExample(page, 'remote', 390);
  const opened = await drawing(page);
  const labels = await labelAudit(page);
  expect(labels.minGlyph, 'part labels ' + labels.minGlyph.toFixed(2) + 'px at ' + opened.zoomPct.toFixed(0) + '%').toBeGreaterThanOrEqual(11);
  expect(opened.espInView).toBe(true);
  expect(await visibleParts(page), 'parts').toEqual([]);
  if (!opened.fitAll) {
    expect(opened.covers).toBe(true);
    return;
  }
  const fit = page.locator('#schFitAll');
  await expect(fit).toBeVisible();
  const box = await fit.boundingBox();
  expect(box && box.width).toBeGreaterThanOrEqual(44);
  expect(box && box.height).toBeGreaterThanOrEqual(44);
  await fit.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await drawing(page)).covers).toBe(true);
});

test('Like breadboard is opt-in and a read-only example keeps it for this tab', async ({ page }) => {
  await install(page);
  await openExample(page, 'blink', 1280);
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#schLayBoard').click();
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#schLayBoard').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#schLayBoard').click();
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { proj?: { parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.parts && app.proj.parts.length && app.schematic);
  });
  await page.locator('#bViewSch').click();
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate(() => ({
    session: sessionStorage.getItem('esp32lab.schLayout.ex.blink'),
    local: localStorage.getItem('esp32lab.schLayout.unsaved'),
  }));
  expect(stored.session).toBe('board');
  expect(stored.local).toBe(null);
  await page.goto('/?ex=simon&resume=0');
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { proj?: { example?: string; parts?: unknown[] }; schematic?: unknown } }).app;
    return !!(app && app.proj && app.proj.example === 'simon' && app.proj.parts && app.proj.parts.length && app.schematic);
  });
  await page.locator('#bViewSch').click();
  await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'false');
});

for (const width of [390, 1280]) {
  test('a first visit with clean storage opens Tidy at ' + width, async ({ page }) => {
    await install(page);
    await page.setViewportSize({ width: width, height: width === 390 ? 844 : 800 });
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto('/?resume=0');
    await page.waitForFunction(() => {
      const app = (window as unknown as { app?: { proj?: { example?: string; parts?: unknown[] }; schematic?: unknown } }).app;
      return !!(app && app.proj && app.proj.example === 'blink' && app.proj.parts && app.proj.parts.length && app.schematic);
    });
    await page.locator('#bViewSch').click();
    await page.waitForFunction(() => document.body.classList.contains('viewsch') && !!document.querySelector('#stageSch.on .sch-hit'));
    await expect(page.locator('#schLayTidy')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'false');
    const stored = await page.evaluate(() => ({
      local: localStorage.getItem('esp32lab.schLayout.unsaved'),
      session: sessionStorage.getItem('esp32lab.schLayout.ex.blink'),
    }));
    expect(stored.local).toBe(null);
    expect(stored.session).toBe(null);
  });
}

test('schmatch=0 hides the control and keeps a schematic', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ex=blink&resume=0&schmatch=0');
  await page.waitForFunction(() => {
    const app = (window as unknown as { app?: { proj?: { parts?: unknown[] }; schematic?: { SCHEMATIC_MATCH_LAYOUT?: boolean } } }).app;
    return !!(app && app.proj && app.proj.parts && app.proj.parts.length);
  });
  const flag = await page.evaluate(() => (window as unknown as { Schematic: { SCHEMATIC_MATCH_LAYOUT: boolean } }).Schematic.SCHEMATIC_MATCH_LAYOUT);
  expect(flag).toBe(false);
  await page.locator('#bViewSch').click();
  await page.waitForFunction(() => !!document.querySelector('#stageSch.on .sch-sym'));
  await expect(page.locator('#schLayout')).toBeHidden();
});

// Drawn nets, recovered from the SVG the page painted. A right-angle cross
// whose intersection is in both interiors is not a join.
async function joined(page: Page, a: { part?: string; name: string }, b: { part?: string; name: string }) {
  return page.evaluate(({ a, b }) => {
    const near = (p: { x: number; y: number }, s: { x1: number; y1: number; x2: number; y2: number }, tol: number) => {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy;
      if (l2 < 1e-6) return Math.hypot(p.x - s.x1, p.y - s.y1) <= tol;
      let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy)) <= tol;
    };
    const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
    document.querySelectorAll('#stageSch path.sch-wire').forEach((el) => {
      const d = el.getAttribute('d') || '';
      let x = 0, y = 0;
      const re = /([ML])([^ML]*)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(d))) {
        const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const nx = nums[i], ny = nums[i + 1];
          if (m[1].toUpperCase() === 'L') segs.push({ x1: x, y1: y, x2: nx, y2: ny });
          x = nx; y = ny;
        }
      }
    });
    const pins = [...document.querySelectorAll('#stageSch circle.sch-pin')].map((el) => ({
      part: el.getAttribute('data-pid') || '',
      name: el.getAttribute('data-pin') || '',
      x: +(el.getAttribute('cx') || 0),
      y: +(el.getAttribute('cy') || 0),
    }));
    const find = (spec: { part?: string; name: string }) => pins.find((p) => p.name === spec.name && (!spec.part || p.part === spec.part));
    const pa = find(a), pb = find(b);
    if (!pa || !pb) return null;
    const parent = new Map<string, string>();
    const findId = (id: string): string => {
      if (!parent.has(id)) parent.set(id, id);
      const p = parent.get(id)!;
      if (p === id) return id;
      const r = findId(p);
      parent.set(id, r);
      return r;
    };
    const union = (u: string, v: string) => { parent.set(findId(u), findId(v)); };
    pins.forEach((p, i) => findId('p' + i));
    segs.forEach((_, i) => findId('s' + i));
    segs.forEach((s, i) => {
      pins.forEach((p, k) => { if (near(p, s, 3)) union('s' + i, 'p' + k); });
      for (let j = 0; j < i; j++) {
        const o = segs[j];
        const touch = near({ x: s.x1, y: s.y1 }, o, 2) || near({ x: s.x2, y: s.y2 }, o, 2)
          || near({ x: o.x1, y: o.y1 }, s, 2) || near({ x: o.x2, y: o.y2 }, s, 2);
        if (touch) union('s' + i, 's' + j);
      }
    });
    const ia = pins.indexOf(pa), ib = pins.indexOf(pb);
    return findId('p' + ia) === findId('p' + ib);
  }, { a, b });
}

for (const width of [1280, 390]) {
  for (const id of ['b_series', 'stopwatch', 'remote']) {
    test(id + ' keeps separate nets at ' + width, async ({ page }) => {
      await install(page);
      await openExample(page, id, width);
      await page.locator('#schLayBoard').click();
      await expect(page.locator('#schLayBoard')).toHaveAttribute('aria-pressed', 'true');
      const led = await joined(page, { part: 'LED1', name: 'A' }, { part: 'LED1', name: 'C' });
      if (led !== null) expect(led, id + ' LED1 anode and cathode').toBe(false);
      const gpio = await joined(page, { name: 'D13' }, { name: 'D25' });
      if (gpio !== null) expect(gpio, id + ' D13 and D25').toBe(false);
      expect(led !== null || gpio !== null, id + ' has neither LED1 nor D13/D25').toBe(true);
    });
  }
}

test('a pinch on the schematic brings Fit all back', async ({ page }) => {
  await install(page);
  await openExample(page, 'blink', 1280);
  await expect(page.locator('#schFitAll')).toBeHidden();
  await page.evaluate(() => {
    const el = document.getElementById('stageSch');
    if (!el) throw new Error('no schematic');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fire = (type: string, pts: { x: number; y: number }[]) => {
      const touches = pts.map((p, i) => new Touch({ identifier: i, target: el, clientX: p.x, clientY: p.y }));
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches }));
    };
    fire('touchstart', [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
    fire('touchmove', [{ x: cx - 120, y: cy }, { x: cx + 120, y: cy }]);
    fire('touchend', []);
  });
  await expect(page.locator('#schFitAll')).toBeVisible();
});
