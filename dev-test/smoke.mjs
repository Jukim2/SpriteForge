// App-level smoke test: boots the real app (index.html -> src/main.js),
// loads a generated sprite sheet, and switches all three workspaces.
// Fails on any pageerror or console error. Used as the safety net for
// the main.js module-split refactor.
import { createServer } from 'vite';
import { chromium } from 'playwright';

const step = (m) => console.log(`[smoke] ${m}`);

const server = await createServer({ server: { port: 5199, strictPort: true } });
await server.listen();
step('vite dev server up');

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
page.setDefaultTimeout(30000);

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const url = m.location()?.url || '';
  // favicon 404 is pre-existing noise unrelated to app code
  if (m.text().includes('Failed to load resource') && url.includes('favicon')) return;
  errors.push(`[console.error] ${m.text()} (${url})`);
});

await page.goto('http://localhost:5199/');
await page.waitForSelector('#dropzone', { state: 'visible' });
step('app loaded, dropzone visible');

// Feed a generated 64x32 PNG (two 32x32 colored cells) through the real
// file-input change handler.
await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(220,60,60)';
  ctx.fillRect(4, 4, 24, 24);
  ctx.fillStyle = 'rgb(60,60,220)';
  ctx.fillRect(36, 4, 24, 24);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'smoke-sheet.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

// Default settings: grid 32x32, skipEmpty -> expect 2 slices.
await page.waitForFunction(() => {
  const el = document.getElementById('preview-count');
  return el && parseInt(el.textContent, 10) >= 1;
});
const previewCount = await page.$eval('#preview-count', (el) => el.textContent);
step(`sprite sheet sliced, preview count = ${previewCount}`);

// Animation preview tab (shared slicer/video player).
await page.click('#tab-animation');
await page.click('#tab-slices');
step('animation/slices tabs toggled');

// Workspace round-trip: video -> imgtools -> slicer.
for (const id of ['ws-btn-video', 'ws-btn-imgtools', 'ws-btn-slicer']) {
  await page.click(`#${id}`);
  await page.waitForTimeout(200);
  step(`workspace switched via #${id}`);
}

// Slicer mode buttons (grid/auto/custom re-slice paths).
for (const id of ['mode-auto', 'mode-custom', 'mode-grid']) {
  await page.click(`#${id}`);
  await page.waitForTimeout(200);
  step(`slicer mode #${id} ok`);
}

await browser.close();
await server.close();

if (errors.length) {
  console.error('SMOKE FAILED with page errors:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
step('PASS — no page errors');
