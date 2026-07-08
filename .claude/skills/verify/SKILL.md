---
name: verify
description: Verify SpriteForge UI changes end-to-end by driving the real app in headless Chrome via Playwright. Use after changing src/ UI/feature code to observe the change at the browser surface instead of unit-calling functions.
---

# Verifying SpriteForge changes

The app is a Vite SPA (no test suite). Verify UI changes by driving the real
`index.html` in headless Chromium with Playwright — both are already in
`node_modules` (Playwright is a dep of the headless CLI).

## Recipe

Write a temp `.mjs` script **inside the repo** (bare imports must resolve from
project `node_modules`), run it with `node`, delete it after:

```js
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ root: '<repo>', server: { port: 5198, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto('http://localhost:5198/');
```

- GPU args only matter for AI paths; for fast deterministic runs pick non-AI
  algorithms (e.g. upscale `nearest`).
- Feed images without disk files: build a canvas in `page.evaluate`, return
  `toDataURL` base64, then `page.setInputFiles('#file-input', { name, mimeType, buffer })`.

## Useful hooks (element IDs)

- Workspace switch: `#ws-btn-slicer` / `#ws-btn-video` / `#ws-btn-imgtools`;
  active viewport = `#<ws>-viewport-content` without `hidden` class.
- Slicer: file input `#file-input`, slices `#preview-grid .sprite-preview-item`,
  send-to-imgtools `#btn-slices-to-imgtools`, file list `#file-list .file-item`.
- Image Tools: tool tabs `#imgtools-mode-{upscale,bgremove,vector,compress}`,
  process `#btn-imgtools-process`, done when `#btn-imgtools-download` enabled,
  result label `#imgtools-result-meta`, active file info `#imgtools-info`,
  chain state `#imgtools-original-label` ("Original" vs "Input · Step N"),
  revert `#btn-imgtools-revert`, to-slicer `#btn-imgtools-to-slicer`,
  file list `#imgtools-file-list li`.
- Video: send-frames button `#btn-video-to-imgtools`.
- Toasts land in `#toast-container` (clear its innerHTML before probing).

## Gotchas

- App state (`src/app/state.js`) is module-scoped, not on `window` — assert
  via DOM, not via `page.evaluate(() => state...)`.
- Loading video needs a real encoded file; for cheap probes just assert the
  no-frames warning toast.
- The headless CLI (`npm run headless`, `scripts/sf-headless.mjs`) drives the
  same src/ pipeline via `headless.html` — good for verifying processing
  algorithms, useless for UI/button wiring.
