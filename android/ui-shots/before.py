from playwright.sync_api import sync_playwright
import sys
out = sys.argv[1] if len(sys.argv) > 1 else 'before'
with sync_playwright() as p:
    b = p.chromium.launch()
    c = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = c.new_page(); pg.goto('http://127.0.0.1:18765/'); pg.wait_for_timeout(2500)
    pg.screenshot(path=f'/workspace/esp32-lab-android/ui-shots/{out}-main.png')
    b.close()
