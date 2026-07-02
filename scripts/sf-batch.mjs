#!/usr/bin/env node
/**
 * SpriteForge headless batch upscaler.
 *
 * Runs the same upscaling algorithms as the web app, but from the command line
 * with direct filesystem access — no browser, no manual download/replace. Scans
 * a folder (optionally recursively), upscales every image, and writes results
 * either into an "_upscaled" subfolder (default, safe) or over the originals
 * (--replace).
 *
 * Usage:
 *   node scripts/sf-batch.mjs <folder> [options]
 *
 * Options:
 *   --algo <ai|xbr|smooth|nearest>   Algorithm (default: ai)
 *   --model <key>                    AI model: anime-best | general-best |
 *                                    anime | general (default: anime-best)
 *   --scale <2|3|4>                  Scale factor (default: 4)
 *   --recursive                      Include subfolders (default: on for folders)
 *   --no-recursive                   Top-level images only
 *   --replace                        Overwrite originals in place
 *   --out <dir>                      Custom output folder name (default: _upscaled)
 *   --suffix <text>                  Filename suffix (default: derived, e.g. _ai_x4)
 *
 * Examples:
 *   node scripts/sf-batch.mjs ./sprites --ai --scale 4
 *   node scripts/sf-batch.mjs ./sprites --algo xbr --scale 3 --replace
 */

import { readdir, mkdir, readFile } from 'node:fs/promises';
import { join, dirname, relative, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const MODELS_DIR = join(PROJECT_ROOT, 'public', 'models');

const AI_MODELS = {
  'anime-best':   { file: 'realesrgan-x4plus-anime6b.onnx', scale: 4, label: 'Illustration/Game — Best' },
  'general-best': { file: 'realesrgan-x4plus.onnx',         scale: 4, label: 'General/Photo — Best' },
  anime:          { file: 'realesrgan-x4-anime.onnx',       scale: 4, label: 'Illustration/Game — Fast' },
  general:        { file: 'realesrgan-x4-general.onnx',     scale: 4, label: 'General/Photo — Fast' }
};

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    folder: null,
    algo: 'ai',
    model: 'anime-best',
    scale: 4,
    recursive: true,
    replace: false,
    out: '_upscaled',
    suffix: null
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--ai': opts.algo = 'ai'; break;
      case '--xbr': opts.algo = 'xbr'; break;
      case '--smooth': opts.algo = 'smooth'; break;
      case '--nearest': opts.algo = 'nearest'; break;
      case '--algo': opts.algo = argv[++i]; break;
      case '--model': opts.model = argv[++i]; break;
      case '--scale': opts.scale = parseInt(argv[++i], 10); break;
      case '--recursive': opts.recursive = true; break;
      case '--no-recursive': opts.recursive = false; break;
      case '--replace': opts.replace = true; break;
      case '--out': opts.out = argv[++i]; break;
      case '--suffix': opts.suffix = argv[++i]; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
        rest.push(a);
    }
  }
  opts.folder = rest[0] || null;
  if (![2, 3, 4].includes(opts.scale)) throw new Error('--scale must be 2, 3 or 4');
  if (!['ai', 'xbr', 'smooth', 'nearest'].includes(opts.algo)) throw new Error(`Unknown --algo: ${opts.algo}`);
  if (opts.algo === 'ai' && !AI_MODELS[opts.model]) throw new Error(`Unknown --model: ${opts.model}`);
  return opts;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function scanImages(root, recursive) {
  const found = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '_upscaled') continue; // never re-ingest our own output
        if (recursive) await walk(full);
      } else if (e.isFile() && IMAGE_RE.test(e.name)) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Image I/O (sharp) → flat RGBA
// ---------------------------------------------------------------------------

let sharp;
async function getSharp() {
  if (!sharp) sharp = (await import('sharp')).default;
  return sharp;
}

async function decodeRGBA(path) {
  const s = await getSharp();
  const { data, info } = await s(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

async function encodePNG(rgba, width, height, outPath) {
  const s = await getSharp();
  await mkdir(dirname(outPath), { recursive: true });
  await s(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 }
  }).png().toFile(outPath);
}

// ---------------------------------------------------------------------------
// nearest / smooth via sharp
// ---------------------------------------------------------------------------

async function upscaleResize(path, scale, kernel) {
  const s = await getSharp();
  const meta = await s(path).metadata();
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const buf = await s(path)
    .ensureAlpha()
    .resize(width, height, { kernel, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(buf.data), width: buf.info.width, height: buf.info.height };
}

// ---------------------------------------------------------------------------
// xBR (pixel art) — pure JS, no DOM
// ---------------------------------------------------------------------------

async function upscaleXbr(path, scale) {
  const factor = Math.round(scale);
  if (![2, 3, 4].includes(factor)) throw new Error('xBR supports 2x, 3x or 4x');
  // xbr-js has no package "main"/"exports" for Node ESM; load the built ESM bundle directly.
  const { xbr2x, xbr3x, xbr4x } = await import('xbr-js/dist/xBRjs.esm.js');
  const { data, width, height } = await decodeRGBA(path);
  // View RGBA bytes as little-endian Uint32 (0xAABBGGRR) as xbr-js expects.
  const pixels = new Uint32Array(data.buffer, data.byteOffset, width * height);
  const fn = factor === 2 ? xbr2x : factor === 3 ? xbr3x : xbr4x;
  const scaled = fn(pixels, width, height, { blendColors: true, scaleAlpha: true });
  const out = new Uint8ClampedArray(scaled.buffer, scaled.byteOffset, scaled.length * 4);
  return { data: out, width: width * factor, height: height * factor };
}

// ---------------------------------------------------------------------------
// AI super-resolution (Real-ESRGAN x4, onnxruntime-node)
// ---------------------------------------------------------------------------

let ort;
const sessions = {};

async function getSession(modelKey) {
  if (sessions[modelKey]) return sessions[modelKey];
  if (!ort) ort = await import('onnxruntime-node');
  const model = AI_MODELS[modelKey];
  const buffer = await readFile(join(MODELS_DIR, model.file));
  sessions[modelKey] = await ort.InferenceSession.create(buffer, {
    graphOptimizationLevel: 'all'
  });
  return sessions[modelKey];
}

/** Dilate opaque edge colors into transparent regions to avoid dark halos. */
function bleedEdgeColors(data, width, height, passes = 6) {
  let frontier = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) frontier[p] = data[p * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(frontier);
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (frontier[p]) continue;
        let rSum = 0, gSum = 0, bSum = 0, n = 0;
        if (x > 0 && frontier[p - 1]) { const q = (p - 1) * 4; rSum += data[q]; gSum += data[q + 1]; bSum += data[q + 2]; n++; }
        if (x < width - 1 && frontier[p + 1]) { const q = (p + 1) * 4; rSum += data[q]; gSum += data[q + 1]; bSum += data[q + 2]; n++; }
        if (y > 0 && frontier[p - width]) { const q = (p - width) * 4; rSum += data[q]; gSum += data[q + 1]; bSum += data[q + 2]; n++; }
        if (y < height - 1 && frontier[p + width]) { const q = (p + width) * 4; rSum += data[q]; gSum += data[q + 1]; bSum += data[q + 2]; n++; }
        if (n > 0) {
          const q = p * 4;
          data[q] = rSum / n; data[q + 1] = gSum / n; data[q + 2] = bSum / n;
          next[p] = 1; changed = true;
        }
      }
    }
    frontier = next;
    if (!changed) break;
  }
}

async function runTile(session, rgba, tileW, tileH, modelScale) {
  const plane = tileW * tileH;
  const input = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    input[p] = rgba[p * 4] / 255;
    input[plane + p] = rgba[p * 4 + 1] / 255;
    input[2 * plane + p] = rgba[p * 4 + 2] / 255;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, tileH, tileW]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const out = results[session.outputNames[0]];
  const [, , outH, outW] = out.dims;
  if (outH !== tileH * modelScale || outW !== tileW * modelScale) {
    throw new Error(`Unexpected AI output ${outW}x${outH} for ${tileW}x${tileH} input`);
  }
  return { data: out.data, width: outW, height: outH };
}

async function upscaleAI(path, modelKey, onTile) {
  const model = AI_MODELS[modelKey];
  const session = await getSession(modelKey);
  const modelScale = model.scale;

  const src = await decodeRGBA(path);
  const { width: srcW, height: srcH } = src;
  const work = new Uint8ClampedArray(src.data); // bleed mutates RGB

  let hasAlpha = false;
  for (let i = 3; i < work.length; i += 4) { if (work[i] < 255) { hasAlpha = true; break; } }
  if (hasAlpha) bleedEdgeColors(work, srcW, srcH);

  const TILE = 128;
  const PAD = 8;
  const outW = srcW * modelScale;
  const outH = srcH * modelScale;
  const outData = new Uint8ClampedArray(outW * outH * 4);

  const tilesX = Math.ceil(srcW / TILE);
  const tilesY = Math.ceil(srcH / TILE);
  const total = tilesX * tilesY;
  let done = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const coreX = tx * TILE, coreY = ty * TILE;
      const coreW = Math.min(TILE, srcW - coreX);
      const coreH = Math.min(TILE, srcH - coreY);
      const padX0 = Math.min(PAD, coreX), padY0 = Math.min(PAD, coreY);
      const padX1 = Math.min(PAD, srcW - coreX - coreW), padY1 = Math.min(PAD, srcH - coreY - coreH);
      const tileX = coreX - padX0, tileY = coreY - padY0;
      const tileW = coreW + padX0 + padX1, tileH = coreH + padY0 + padY1;

      const tileRgba = new Uint8ClampedArray(tileW * tileH * 4);
      for (let y = 0; y < tileH; y++) {
        const srcOff = ((tileY + y) * srcW + tileX) * 4;
        tileRgba.set(work.subarray(srcOff, srcOff + tileW * 4), y * tileW * 4);
      }

      const result = await runTile(session, tileRgba, tileW, tileH, modelScale);
      const s = modelScale;
      const rplane = result.width * result.height;
      for (let y = 0; y < coreH * s; y++) {
        const srcRow = padY0 * s + y;
        const dstRow = coreY * s + y;
        for (let x = 0; x < coreW * s; x++) {
          const sp = srcRow * result.width + (padX0 * s + x);
          const dp = (dstRow * outW + (coreX * s + x)) * 4;
          outData[dp] = Math.max(0, Math.min(1, result.data[sp])) * 255;
          outData[dp + 1] = Math.max(0, Math.min(1, result.data[rplane + sp])) * 255;
          outData[dp + 2] = Math.max(0, Math.min(1, result.data[2 * rplane + sp])) * 255;
          outData[dp + 3] = 255;
        }
      }
      done++;
      if (onTile) onTile(done, total);
    }
  }

  // Recombine alpha: high-quality resample of the original alpha channel.
  if (hasAlpha) {
    const s = await getSharp();
    const alphaSrc = Buffer.alloc(srcW * srcH);
    for (let p = 0; p < srcW * srcH; p++) alphaSrc[p] = src.data[p * 4 + 3];
    const alphaBig = await s(alphaSrc, { raw: { width: srcW, height: srcH, channels: 1 } })
      .resize(outW, outH, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer();
    for (let p = 0; p < outW * outH; p++) outData[p * 4 + 3] = alphaBig[p];
  }

  return { data: outData, width: outW, height: outH };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function defaultSuffix(opts) {
  if (opts.suffix != null) return opts.suffix;
  return `_${opts.algo}_x${opts.scale}`;
}

function outputPathFor(inputPath, root, opts) {
  const suffix = defaultSuffix(opts);
  const dir = dirname(inputPath);
  const base = basename(inputPath, extname(inputPath));
  const name = `${base}${opts.replace ? '' : suffix}.png`;
  if (opts.replace) return join(dir, name);
  // Mirror subfolder structure under <root>/<out>/
  const rel = relative(root, dir);
  return join(root, opts.out, rel, name);
}

async function processOne(path, root, opts) {
  let result;
  if (opts.algo === 'ai') {
    result = await upscaleAI(path, opts.model, null);
    if (opts.scale !== AI_MODELS[opts.model].scale) {
      // Resample the 4x AI result down to the requested factor.
      const s = await getSharp();
      const factor = opts.scale / AI_MODELS[opts.model].scale;
      const w = Math.round(result.width * factor);
      const h = Math.round(result.height * factor);
      const buf = await s(Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength), {
        raw: { width: result.width, height: result.height, channels: 4 }
      }).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
      result = { data: new Uint8ClampedArray(buf.data), width: buf.info.width, height: buf.info.height };
    }
  } else if (opts.algo === 'xbr') {
    result = await upscaleXbr(path, opts.scale);
  } else if (opts.algo === 'nearest') {
    result = await upscaleResize(path, opts.scale, 'nearest');
  } else {
    result = await upscaleResize(path, opts.scale, 'lanczos3');
  }
  const outPath = outputPathFor(path, root, opts);
  await encodePNG(result.data, result.width, result.height, outPath);
  return outPath;
}

function printHelp() {
  console.log(`SpriteForge headless batch upscaler

Usage: node scripts/sf-batch.mjs <folder> [options]

  --algo <ai|xbr|smooth|nearest>  Algorithm (default: ai)
  --ai|--xbr|--smooth|--nearest   Shorthand for --algo
  --model <key>                   anime-best | general-best | anime | general
  --scale <2|3|4>                 Scale factor (default: 4)
  --no-recursive                  Top-level images only
  --replace                       Overwrite originals in place
  --out <dir>                     Output subfolder name (default: _upscaled)
  --suffix <text>                 Filename suffix (default: _<algo>_x<scale>)

Examples:
  node scripts/sf-batch.mjs ./sprites --ai --scale 4
  node scripts/sf-batch.mjs ./sprites --xbr --scale 3 --replace`);
}

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
  const images = await scanImages(root, opts.recursive);
  if (images.length === 0) {
    console.error(`✗ No PNG/JPEG/WebP images found in ${root}`);
    process.exit(1);
  }

  const modeLabel = opts.algo === 'ai' ? `AI (${AI_MODELS[opts.model].label})` : opts.algo;
  const dest = opts.replace ? 'in place (originals overwritten)' : `${opts.out}/ subfolder`;
  console.log(`SpriteForge batch — ${images.length} image(s)`);
  console.log(`  algorithm : ${modeLabel} · ${opts.scale}x`);
  console.log(`  output    : ${dest}`);
  console.log('');

  let ok = 0, fail = 0;
  const startAll = process.hrtime.bigint();
  for (let i = 0; i < images.length; i++) {
    const path = images[i];
    const rel = relative(root, path) || basename(path);
    process.stdout.write(`  [${i + 1}/${images.length}] ${rel} ... `);
    const t0 = process.hrtime.bigint();
    try {
      await processOne(path, root, opts);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`done (${(ms / 1000).toFixed(1)}s)`);
      ok++;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      fail++;
    }
  }
  const totalMs = Number(process.hrtime.bigint() - startAll) / 1e6;
  console.log('');
  console.log(`✓ ${ok} processed, ${fail} failed in ${(totalMs / 1000).toFixed(1)}s`);
  if (!opts.replace) console.log(`  → results in ${join(root, opts.out)}`);
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
