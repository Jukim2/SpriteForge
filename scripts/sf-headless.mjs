#!/usr/bin/env node
/**
 * SpriteForge headless runner.
 *
 * Drives the REAL web-app pipeline from the command line by loading
 * headless.html (project root) inside a Playwright-controlled Chrome. GPU-heavy
 * tools (AI upscale, AI background removal) run on the browser's WebGPU path,
 * which reaches the discrete GPU (verified: RTX 4060 Ti via --headless=new) — so
 * results match the app with no algorithm reimplementation. There is exactly
 * one implementation of every algorithm: the app's own src/ code, which
 * headless.html imports directly.
 *
 * Tools:
 *   upscale    1->1  AI / xBR / smooth / nearest upscaling
 *   bgremove   1->1  AI background removal (seg models on GPU, imgly on CPU)
 *   vectorize  1->1  raster -> SVG
 *   compress   1->1  re-encode (e.g. -> WebP), no resize
 *   chromakey  1->1  color-key background removal
 *   slice      1->N  sprite sheet -> individual sprite PNGs
 *   extract    1->N  video -> frame images
 *   gif        N->1  a folder of frames -> one animated GIF
 *
 * Usage:
 *   node scripts/sf-headless.mjs <folder> --tool <tool> [options]
 *   node scripts/sf-headless.mjs --help
 */

import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)$/i;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4'
};

const PORT = 5199;
const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'];

const MAP_TOOLS = new Set(['upscale', 'bgremove', 'vectorize', 'compress', 'chromakey']);
const ALL_TOOLS = ['upscale', 'bgremove', 'vectorize', 'compress', 'chromakey', 'slice', 'extract', 'gif'];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    folder: null, tool: 'upscale',
    algo: 'ai', model: null, scale: 4,
    mode: 'pixel', preset: 'photo', colors: 6,
    // slice
    auto: false, gridW: null, gridH: null, skipEmpty: true, alpha: 5, mergeGap: 0,
    // chromakey
    color: '#00ff00', tolerance: 15, contiguous: true, despill: 0.85,
    // video extract
    start: 0, end: undefined, interval: undefined,
    // gif
    fps: 12,
    // output
    format: 'png', quality: 90, out: '_out', replace: false, suffix: null,
    recursive: true, requireGpu: false, headed: false, timeout: 180000
  };
  const rest = [];
  const grid = (v) => { const m = /^(\d+)x(\d+)$/i.exec(v); if (!m) throw new Error(`--grid must be WxH (e.g. 64x64), got ${v}`); return [parseInt(m[1], 10), parseInt(m[2], 10)]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--tool': opts.tool = argv[++i]; break;
      case '--algo': opts.algo = argv[++i]; break;
      case '--model': opts.model = argv[++i]; break;
      case '--scale': opts.scale = parseInt(argv[++i], 10); break;
      case '--mode': opts.mode = argv[++i]; break;
      case '--preset': opts.preset = argv[++i]; break;
      case '--colors': opts.colors = parseInt(argv[++i], 10); break;
      case '--auto': opts.auto = true; break;
      case '--grid': { const [w, h] = grid(argv[++i]); opts.gridW = w; opts.gridH = h; break; }
      case '--skip-empty': opts.skipEmpty = true; break;
      case '--no-skip-empty': opts.skipEmpty = false; break;
      case '--alpha': opts.alpha = parseInt(argv[++i], 10); break;
      case '--merge-gap': opts.mergeGap = parseInt(argv[++i], 10); break;
      case '--color': opts.color = argv[++i]; break;
      case '--tolerance': opts.tolerance = parseInt(argv[++i], 10); break;
      case '--no-contiguous': opts.contiguous = false; break;
      case '--despill': opts.despill = parseFloat(argv[++i]); break;
      case '--start': opts.start = parseFloat(argv[++i]); break;
      case '--end': opts.end = parseFloat(argv[++i]); break;
      case '--interval': opts.interval = parseFloat(argv[++i]); break;
      case '--fps': opts.fps = parseFloat(argv[++i]); break;
      case '--format': opts.format = argv[++i]; break;
      case '--webp': opts.format = 'webp'; break;
      case '--quality': opts.quality = parseInt(argv[++i], 10); break;
      case '--out': opts.out = argv[++i]; break;
      case '--replace': opts.replace = true; break;
      case '--suffix': opts.suffix = argv[++i]; break;
      case '--no-recursive': opts.recursive = false; break;
      case '--require-gpu': opts.requireGpu = true; break;
      case '--headed': opts.headed = true; break;
      case '--timeout': opts.timeout = parseInt(argv[++i], 10); break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
        rest.push(a);
    }
  }
  opts.folder = rest[0] || null;
  if (!ALL_TOOLS.includes(opts.tool)) throw new Error(`Unknown --tool: ${opts.tool} (use ${ALL_TOOLS.join('|')})`);
  if (!['png', 'webp'].includes(opts.format)) throw new Error(`Unknown --format: ${opts.format}`);
  if (!(opts.quality >= 1 && opts.quality <= 100)) throw new Error('--quality must be 1-100');
  if (opts.tool === 'upscale') {
    if (!['ai', 'xbr', 'smooth', 'nearest'].includes(opts.algo)) throw new Error(`Unknown --algo: ${opts.algo}`);
    if (![2, 3, 4].includes(opts.scale)) throw new Error('--scale must be 2, 3 or 4');
    if (!opts.model) opts.model = 'anime-best';
  }
  if (opts.tool === 'bgremove' && !opts.model) opts.model = 'anime-isnet';
  return opts;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function defaultSuffix(opts) {
  if (opts.suffix != null) return opts.suffix;
  switch (opts.tool) {
    case 'upscale': return `_${opts.algo}_x${opts.scale}`;
    case 'bgremove': return '_nobg';
    case 'vectorize': return `_${opts.mode}`;
    case 'compress': return `_${opts.format}`;
    case 'chromakey': return '_key';
    default: return '_out';
  }
}

function mapOutExt(opts) { return opts.tool === 'vectorize' ? 'svg' : opts.format; }

function mapOutputPath(inputPath, root, opts) {
  const dir = dirname(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const canReplace = opts.replace && opts.tool !== 'vectorize';
  const name = `${base}${canReplace ? '' : defaultSuffix(opts)}.${mapOutExt(opts)}`;
  if (canReplace) return join(dir, name);
  return join(root, opts.out, relative(root, dir), name);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

async function scan(root, recursive, re, outDirName) {
  const excluded = new Set(['_out', outDirName].filter(Boolean));
  const found = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (excluded.has(e.name)) continue;
        if (recursive) await walk(full);
      } else if (e.isFile() && re.test(e.name)) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found.sort();
}

function toDataUrl(bytes, path) {
  const mime = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function writeDataUrl(dataUrl, outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(outPath, Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------------------
// Per-category process options
// ---------------------------------------------------------------------------

function mapProcessOpts(opts) {
  const base = { tool: opts.tool, format: opts.format, quality: opts.quality };
  switch (opts.tool) {
    case 'upscale': return { ...base, algorithm: opts.algo, scale: opts.scale, aiModel: opts.model };
    case 'bgremove': return { ...base, model: opts.model };
    case 'chromakey': return { ...base, color: opts.color, tolerance: opts.tolerance, contiguous: opts.contiguous, despill: opts.despill };
    case 'vectorize': return { ...base, mode: opts.mode, preset: opts.preset, colors: opts.colors };
    case 'compress': return base;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runMap(page, images, root, opts, report) {
  const pOpts = mapProcessOpts(opts);
  for (let i = 0; i < images.length; i++) {
    const path = images[i];
    const rel = relative(root, path) || basename(path);
    process.stdout.write(`  [${i + 1}/${images.length}] ${rel} ... `);
    const t0 = process.hrtime.bigint();
    try {
      const dataUrl = toDataUrl(await readFile(path), path);
      report.pageErrors.length = 0;
      const result = await page.evaluate(async ({ dataUrl, pOpts }) => window.sf.process(dataUrl, pOpts), { dataUrl, pOpts });
      if (opts.requireGpu && result.backend && result.backend !== 'webgpu') throw new Error(`ran on ${result.backend}, not WebGPU (--require-gpu)`);
      if (result.backend && result.backend !== 'webgpu') report.sawCpu = true;

      const outPath = mapOutputPath(path, root, opts);
      await mkdir(dirname(outPath), { recursive: true });
      if (result.svg != null) await writeFile(outPath, result.svg, 'utf8');
      else await writeDataUrl(result.dataUrl, outPath);

      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const tag = result.backend ? ` [${result.backend}]` : '';
      const dim = result.width ? ` ${result.width}x${result.height}` : '';
      console.log(`done${dim}${tag} (${(ms / 1000).toFixed(1)}s)`);
      report.ok++;
    } catch (err) {
      console.log(`FAILED — ${err.message}${report.pageErrors.length ? ` | page: ${report.pageErrors[0]}` : ''}`);
      report.fail++;
    }
  }
}

async function runSlice(page, images, root, opts, report) {
  const sOpts = {
    auto: opts.auto, gridW: opts.gridW, gridH: opts.gridH, skipEmpty: opts.skipEmpty,
    alphaThreshold: opts.alpha, mergeGap: opts.mergeGap, format: opts.format, quality: opts.quality
  };
  for (let i = 0; i < images.length; i++) {
    const path = images[i];
    const rel = relative(root, path) || basename(path);
    process.stdout.write(`  [${i + 1}/${images.length}] ${rel} ... `);
    const t0 = process.hrtime.bigint();
    try {
      const dataUrl = toDataUrl(await readFile(path), path);
      report.pageErrors.length = 0;
      const result = await page.evaluate(async ({ dataUrl, sOpts }) => window.sf.slice(dataUrl, sOpts), { dataUrl, sOpts });
      const base = basename(path, extname(path));
      const outDir = join(root, opts.out, relative(root, dirname(path)), `${base}_slices`);
      for (let n = 0; n < result.items.length; n++) {
        const name = `sprite_${String(n).padStart(3, '0')}.${opts.format}`;
        await writeDataUrl(result.items[n].dataUrl, join(outDir, name));
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`done — ${result.count} sprites (${(ms / 1000).toFixed(1)}s)`);
      report.ok++;
      report.produced += result.count;
    } catch (err) {
      console.log(`FAILED — ${err.message}${report.pageErrors.length ? ` | page: ${report.pageErrors[0]}` : ''}`);
      report.fail++;
    }
  }
}

async function runExtract(page, videos, root, opts, report) {
  const eOpts = {
    start: opts.start, end: opts.end,
    mode: opts.interval != null ? 'interval' : 'all', interval: opts.interval,
    format: opts.format, quality: opts.quality
  };
  for (let i = 0; i < videos.length; i++) {
    const path = videos[i];
    const rel = relative(root, path) || basename(path);
    process.stdout.write(`  [${i + 1}/${videos.length}] ${rel} ... `);
    const t0 = process.hrtime.bigint();
    try {
      const dataUrl = toDataUrl(await readFile(path), path);
      report.pageErrors.length = 0;
      const result = await page.evaluate(async ({ dataUrl, eOpts }) => window.sf.extract(dataUrl, eOpts), { dataUrl, eOpts });
      const base = basename(path, extname(path));
      const outDir = join(root, opts.out, relative(root, dirname(path)), `${base}_frames`);
      for (let n = 0; n < result.items.length; n++) {
        const name = `frame_${String(n).padStart(4, '0')}.${opts.format}`;
        await writeDataUrl(result.items[n].dataUrl, join(outDir, name));
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`done — ${result.count} frames (${(ms / 1000).toFixed(1)}s)`);
      report.ok++;
      report.produced += result.count;
    } catch (err) {
      console.log(`FAILED — ${err.message}${report.pageErrors.length ? ` | page: ${report.pageErrors[0]}` : ''}`);
      report.fail++;
    }
  }
}

async function runGif(page, images, root, opts, report) {
  // All images in the folder become one animated GIF, ordered by filename.
  process.stdout.write(`  building GIF from ${images.length} frame(s) @ ${opts.fps}fps ... `);
  const t0 = process.hrtime.bigint();
  try {
    const dataUrls = [];
    for (const path of images) dataUrls.push(toDataUrl(await readFile(path), path));
    report.pageErrors.length = 0;
    const result = await page.evaluate(async ({ dataUrls, gOpts }) => window.sf.gif(dataUrls, gOpts), { dataUrls, gOpts: { fps: opts.fps } });
    const name = `${opts.suffix || basename(root) || 'animation'}.gif`;
    const outPath = join(root, opts.out, name);
    await writeDataUrl(result.dataUrl, outPath);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`done — ${result.width}x${result.height}, ${result.frames} frames (${(ms / 1000).toFixed(1)}s)`);
    console.log(`  → ${outPath}`);
    report.ok++;
    report.produced += 1;
  } catch (err) {
    console.log(`FAILED — ${err.message}${report.pageErrors.length ? ` | page: ${report.pageErrors[0]}` : ''}`);
    report.fail++;
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`SpriteForge headless runner

Usage: node scripts/sf-headless.mjs <folder> --tool <tool> [options]

Tools:
  upscale    AI/xBR/smooth/nearest upscaling      (1 image -> 1 image)
  bgremove   AI background removal                (1 -> 1)
  vectorize  raster -> SVG                        (1 -> 1)
  compress   re-encode (e.g. -> WebP), no resize  (1 -> 1)
  chromakey  color-key background removal         (1 -> 1)
  slice      sprite sheet -> individual sprites   (1 -> N, into <base>_slices/)
  extract    video -> frames                      (1 -> N, into <base>_frames/)
  gif        folder of frames -> one animated GIF (N -> 1)

Common:
  --format <png|webp>  raster output (default png)   --webp   --quality <1-100>
  --out <dir>          output subfolder (default _out)   --replace (1->1 only)
  --require-gpu        fail if AI work runs on CPU/WASM instead of WebGPU
  --no-recursive       top-level only               --headed (debug)

upscale:   --algo <ai|xbr|smooth|nearest> --model <anime-best|general-best|anime|general> --scale <2|3|4>
bgremove:  --model <anime-isnet|toonout|rmbg14|isnet|isnet_fp16|isnet_quint8>
vectorize: --mode <pixel|trace> --colors <1-8>
chromakey: --color <#00ff00> --tolerance <0-100> --no-contiguous --despill <0-1>
slice:     --grid <WxH> | --auto   --no-skip-empty --alpha <0-255> --merge-gap <px>
extract:   --interval <sec> (omit = every frame)   --start <sec> --end <sec>
gif:       --fps <n>   --suffix <name>

Examples:
  node scripts/sf-headless.mjs ./sprites --tool upscale --model anime-best --scale 4 --require-gpu
  node scripts/sf-headless.mjs ./chars  --tool bgremove --model anime-isnet --webp --require-gpu
  node scripts/sf-headless.mjs ./sheets --tool slice --grid 64x64
  node scripts/sf-headless.mjs ./sheets --tool slice --auto
  node scripts/sf-headless.mjs ./clips  --tool extract --interval 0.5
  node scripts/sf-headless.mjs ./frames --tool gif --fps 12`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}\n`);
    printHelp();
    process.exit(1);
  }
  if (opts.help || !opts.folder) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const root = resolve(opts.folder);
  const isVideoTool = opts.tool === 'extract';
  const inputs = await scan(root, opts.recursive, isVideoTool ? VIDEO_RE : IMAGE_RE, opts.replace ? null : opts.out);
  if (inputs.length === 0) {
    console.error(`✗ No ${isVideoTool ? 'video' : 'image'} files found in ${root}`);
    process.exit(1);
  }

  const server = await createServer({ server: { port: PORT, strictPort: true } });
  await server.listen();

  const launchArgs = opts.headed ? GPU_ARGS : ['--headless=new', ...GPU_ARGS];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: !opts.headed, args: launchArgs });
  } catch (err) {
    console.error(`✗ Failed to launch Chrome: ${err.message}`);
    console.error('  (needs Google Chrome installed; this uses channel "chrome" for reliable WebGPU)');
    await server.close();
    process.exit(1);
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(opts.timeout);
  const report = { ok: 0, fail: 0, produced: 0, sawCpu: false, pageErrors: [] };
  page.on('pageerror', (e) => report.pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.pageErrors.push(m.text()); });

  await page.goto(`http://localhost:${PORT}/headless.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready);

  const hasGpu = await page.evaluate(() => window.sf.hasWebGpu);
  const usesAi = (opts.tool === 'upscale' && opts.algo === 'ai') || opts.tool === 'bgremove';
  if (opts.requireGpu && usesAi && !hasGpu) {
    console.error('✗ --require-gpu set but the headless browser has no WebGPU adapter.');
    await browser.close();
    await server.close();
    process.exit(2);
  }

  const modeLabel = opts.tool === 'upscale'
    ? `upscale ${opts.algo}${opts.algo === 'ai' ? ` (${opts.model})` : ''} ${opts.scale}x`
    : opts.tool === 'bgremove' ? `bgremove (${opts.model})`
    : opts.tool === 'vectorize' ? `vectorize (${opts.mode})`
    : opts.tool === 'chromakey' ? `chromakey (${opts.color} ±${opts.tolerance})`
    : opts.tool === 'slice' ? `slice (${opts.auto ? 'auto' : opts.gridW ? `${opts.gridW}x${opts.gridH}` : 'auto-grid'})`
    : opts.tool === 'extract' ? `extract (${opts.interval != null ? `every ${opts.interval}s` : 'all frames'})`
    : opts.tool === 'gif' ? `gif (${opts.fps}fps)`
    : opts.tool;
  console.log(`SpriteForge headless — ${inputs.length} ${isVideoTool ? 'video' : 'file'}(s)`);
  console.log(`  tool    : ${modeLabel}`);
  if (usesAi) console.log(`  gpu     : ${hasGpu ? 'WebGPU available' : 'none (CPU/WASM)'}`);
  console.log(`  output  : ${opts.replace && MAP_TOOLS.has(opts.tool) ? 'in place' : `${opts.out}/ subfolder`}`);
  console.log('');

  const startAll = process.hrtime.bigint();
  if (MAP_TOOLS.has(opts.tool)) await runMap(page, inputs, root, opts, report);
  else if (opts.tool === 'slice') await runSlice(page, inputs, root, opts, report);
  else if (opts.tool === 'extract') await runExtract(page, inputs, root, opts, report);
  else if (opts.tool === 'gif') await runGif(page, inputs, root, opts, report);
  const totalMs = Number(process.hrtime.bigint() - startAll) / 1e6;

  console.log('');
  const producedLabel = ['slice', 'extract'].includes(opts.tool) ? ` (${report.produced} outputs)` : '';
  console.log(`✓ ${report.ok} processed, ${report.fail} failed${producedLabel} in ${(totalMs / 1000).toFixed(1)}s`);
  if (report.sawCpu) console.log('  ⚠ some images ran on CPU/WASM (no WebGPU). Pass --require-gpu to enforce GPU.');
  if (!(opts.replace && MAP_TOOLS.has(opts.tool))) console.log(`  → results in ${join(root, opts.out)}`);

  await browser.close();
  await server.close();
  process.exit(report.fail > 0 && report.ok === 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
