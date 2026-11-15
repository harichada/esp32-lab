// The 3D loader drops on the first rendered frame, not when a script promise settles.
import { test, expect, type Page } from '@playwright/test';

async function install(page: Page) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.fallback();
    return route.abort();
  });
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"ok":true}',
  }));
  await page.routeWebSocket(/\/api\//, (ws) => { ws.onMessage(() => {}); });
}

test('the 3D loader is hidden once the canvas has drawn', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ex=blink&resume=0');
  await page.locator('#bView3d').click();
  await expect.poll(async () => page.evaluate(() => {
    const app = (window as unknown as {
      app?: { view3d?: { renderer?: { getContext: () => WebGLRenderingContext }; _frames?: number } };
    }).app;
    const v = app && app.view3d;
    const loader = document.getElementById('view3dLoad');
    if (!v || !v.renderer || !loader) return 'wait';
    const gl = v.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const canvas = document.getElementById('stage3d') as HTMLCanvasElement | null;
    if (!canvas || w < 2 || h < 2 || canvas.width < 2 || canvas.height < 2) return 'wait';
    if (!(v._frames && v._frames >= 1)) return 'wait';
    return loader.hidden ? 'hidden' : 'showing';
  }), { timeout: 30_000 }).toBe('hidden');
});
