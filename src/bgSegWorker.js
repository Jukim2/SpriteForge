/**
 * Background-segmentation inference worker.
 *
 * Runs in its own module-worker scope so our onnxruntime-web instance can
 * never collide with the separate ort runtime that @imgly/background-removal
 * bundles for the slicer/video workspaces (loading both in one scope breaks
 * WebGPU init with "webgpuInit is not a function"). Isolation also keeps the
 * UI thread responsive during multi-second inference.
 *
 * Protocol: main thread posts {id, cmd: 'segment', modelKey, imageData};
 * worker replies with {id, type: 'progress'|'done'|'error', ...}. The 'done'
 * message carries the mask as an ImageData (matte in the alpha channel) at
 * the source image's resolution.
 */

import { BG_SEG_MODELS } from './bgSegModels.js';

// ---------------------------------------------------------------------------
// ort runtime (worker-local)
// ---------------------------------------------------------------------------

let ortModule = null;
let backend = null; // 'webgpu' | 'wasm'

async function detectWebGpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function getOrt() {
  if (!ortModule) {
    if (await detectWebGpu()) {
      ortModule = await import('onnxruntime-web/webgpu');
      backend = 'webgpu';
    } else {
      ortModule = await import('onnxruntime-web/wasm');
      backend = 'wasm';
    }
  }
  return ortModule;
}

// ---------------------------------------------------------------------------
// Model download + persistent cache (OPFS)
//
// OPFS streams straight to disk — peak RAM stays at one copy of the model —
// and avoids the Cache API's flaky large-entry behavior. Partial downloads
// live in a .part file and are atomically renamed on completion, so an
// interrupted download never poses as a cached model.
// ---------------------------------------------------------------------------

async function getModelDirHandle() {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('spriteforge-bg-models', { create: true });
  } catch {
    return null; // OPFS unavailable — models re-download each session
  }
}

const cacheFileNameFor = (url) => url.replace(/[^a-zA-Z0-9._-]/g, '_');

async function fetchModelBuffer(url, expectedMB, onProgress) {
  const dir = await getModelDirHandle();
  const name = cacheFileNameFor(url);

  if (dir) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > 0) {
        if (onProgress) onProgress({ label: 'Loading cached model...' });
        return await file.arrayBuffer();
      }
    } catch { /* not cached yet */ }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Model download failed (HTTP ${resp.status})`);
  const total = Number(resp.headers.get('Content-Length')) || (expectedMB ? expectedMB * 1048576 : 0);

  const partName = `${name}.part`;
  let writable = null;
  if (dir) {
    try {
      writable = await (await dir.getFileHandle(partName, { create: true })).createWritable();
    } catch {
      writable = null; // quota/OPFS write issue — fall back to RAM chunks
    }
  }

  const reader = resp.body.getReader();
  const chunks = writable ? null : [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writable) await writable.write(value);
      else chunks.push(value);
      received += value.length;
      if (onProgress && total) {
        const mb = (n) => Math.round(n / 1048576);
        onProgress({
          label: `Downloading model ${mb(received)} / ${mb(total)} MB (one-time, cached after)...`,
          percent: Math.round((received / total) * 100)
        });
      }
    }
  } catch (err) {
    if (writable) {
      try { await writable.close(); await dir.removeEntry(partName); } catch { /* best effort */ }
    }
    throw err;
  }

  if (total && received < total) {
    if (writable) {
      try { await writable.close(); await dir.removeEntry(partName); } catch { /* best effort */ }
    }
    throw new Error('Model download was interrupted — please retry.');
  }

  if (writable) {
    await writable.close();
    const partHandle = await dir.getFileHandle(partName);
    try {
      await partHandle.move(name); // atomic publish
      return await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
    } catch {
      // move() unsupported in this browser: use the .part directly this session
      return await (await partHandle.getFile()).arrayBuffer();
    }
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.length;
  }
  return buffer.buffer;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const segSessions = {}; // modelKey -> { session, backend }

async function createSegSession(modelKey, onProgress) {
  if (segSessions[modelKey]) return segSessions[modelKey];

  const spec = BG_SEG_MODELS[modelKey];
  if (!spec) throw new Error(`Unknown segmentation model: ${modelKey}`);

  // Only one segmentation session lives at a time — these graphs are heavy
  // (hundreds of MB of weights) and stacked sessions overflow the wasm heap.
  for (const key of Object.keys(segSessions)) {
    try { await segSessions[key].session.release(); } catch { /* best effort */ }
    delete segSessions[key];
  }

  const ort = await getOrt();
  let be = backend;

  if (spec.webgpuOnly && be !== 'webgpu') {
    throw new Error(`${spec.shortLabel} needs a WebGPU-capable browser (Chrome/Edge with GPU). Pick another model on this machine.`);
  }

  const create = async (b) => {
    const url = spec.urls[b] || spec.urls.wasm;
    if (!url) throw new Error(`${spec.shortLabel} has no ${b} build.`);
    const buffer = await fetchModelBuffer(url, spec.downloadMB[b] || spec.downloadMB.wasm, onProgress);
    if (onProgress) onProgress({ label: 'Initializing model...' });
    return ort.InferenceSession.create(buffer, {
      executionProviders: [b],
      graphOptimizationLevel: 'all',
      // These nets run once per image; skip arena/pattern preallocation, which
      // otherwise overshoots the 4GB wasm heap on the 1024² graphs.
      enableCpuMemArena: false,
      enableMemPattern: false
    });
  };

  let session;
  if (be === 'webgpu') {
    try {
      session = await create('webgpu');
    } catch (err) {
      console.warn(`WebGPU session failed for ${modelKey}:`, err);
      if (spec.webgpuOnly) {
        throw new Error(`${spec.shortLabel} could not start on the GPU (try reloading the page or freeing memory). It cannot run on CPU — pick another model if this persists.`);
      }
      be = 'wasm';
      session = await create('wasm');
    }
  } else {
    session = await create('wasm');
  }

  segSessions[modelKey] = { session, backend: be };
  return segSessions[modelKey];
}

// ---------------------------------------------------------------------------
// Pre/post-processing
// ---------------------------------------------------------------------------

async function preprocess(imageData, spec) {
  const size = spec.size;
  // Letterbox (SkyTNT ISNet-Anime): aspect-preserving fit, zero padding.
  // Stretch (rembg/RMBG/BiRefNet): fill the whole net input.
  let dx = 0, dy = 0, dw = size, dh = size;
  if (spec.letterbox) {
    const scale = size / Math.max(imageData.width, imageData.height);
    dw = Math.max(1, Math.round(imageData.width * scale));
    dh = Math.max(1, Math.round(imageData.height * scale));
    dx = Math.floor((size - dw) / 2);
    dy = Math.floor((size - dh) / 2);
  }

  const net = new OffscreenCanvas(size, size);
  const nctx = net.getContext('2d', { willReadFrequently: true });
  // Matting nets expect meaningful RGB everywhere; flatten transparency onto
  // white like a screenshot would look. Letterbox padding stays black (zeros),
  // matching SkyTNT's reference pipeline.
  nctx.fillStyle = '#ffffff';
  nctx.fillRect(dx, dy, dw, dh);
  const bmp = await createImageBitmap(imageData);
  nctx.drawImage(bmp, dx, dy, dw, dh);
  bmp.close();
  const { data } = nctx.getImageData(0, 0, size, size);

  const plane = size * size;
  const input = new Float32Array(3 * plane);
  const [mr, mg, mb] = spec.mean;
  const [sr, sg, sb] = spec.std;
  for (let p = 0; p < plane; p++) {
    input[p] = (data[p * 4] / 255 - mr) / sr;
    input[plane + p] = (data[p * 4 + 1] / 255 - mg) / sg;
    input[2 * plane + p] = (data[p * 4 + 2] / 255 - mb) / sb;
  }
  return { input, region: { dx, dy, dw, dh } };
}

function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// Some fp16 exports keep fp16 tensor IO; decode to float when needed.
function toFloatArray(tensor) {
  if (tensor.type === 'float16') {
    if (typeof Float16Array !== 'undefined' && tensor.data instanceof Float16Array) return tensor.data;
    const u16 = tensor.data instanceof Uint16Array ? tensor.data : new Uint16Array(tensor.data.buffer);
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) out[i] = halfToFloat(u16[i]);
    return out;
  }
  return tensor.data;
}

async function segment(modelKey, imageData, onProgress) {
  const spec = BG_SEG_MODELS[modelKey];
  const entry = await createSegSession(modelKey, onProgress);
  const ort = await getOrt();

  if (onProgress) onProgress({ label: `Segmenting with ${spec.shortLabel} (${entry.backend === 'webgpu' ? 'GPU' : 'CPU'})...` });

  const size = spec.size;
  const { input, region } = await preprocess(imageData, spec);
  const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);

  let results;
  try {
    results = await entry.session.run({ [entry.session.inputNames[0]]: tensor });
  } catch (err) {
    // WebGPU op-coverage gaps can surface at run time; retry once on WASM.
    if (entry.backend === 'webgpu' && !spec.webgpuOnly) {
      console.warn(`WebGPU run failed for ${modelKey}, retrying on WASM:`, err);
      delete segSessions[modelKey];
      try { await entry.session.release(); } catch { /* best effort */ }
      const ortMod = await getOrt();
      const buffer = await fetchModelBuffer(spec.urls.wasm, spec.downloadMB.wasm, onProgress);
      const session = await ortMod.InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false,
        enableMemPattern: false
      });
      segSessions[modelKey] = { session, backend: 'wasm' };
      entry.session = session;
      entry.backend = 'wasm';
      results = await session.run({ [session.inputNames[0]]: tensor });
    } else {
      throw err;
    }
  }

  const raw = toFloatArray(results[entry.session.outputNames[0]]);
  const plane = size * size;

  // Postprocess to 0..1 following the reference implementations.
  const pred = raw.length > plane ? raw.subarray(0, plane) : raw;
  const mask01 = new Float32Array(plane);
  if (spec.sigmoid) {
    for (let p = 0; p < plane; p++) mask01[p] = 1 / (1 + Math.exp(-pred[p]));
  } else {
    mask01.set(pred);
  }
  if (spec.minmax) {
    let mi = Infinity, ma = -Infinity;
    for (let p = 0; p < plane; p++) {
      if (mask01[p] < mi) mi = mask01[p];
      if (mask01[p] > ma) ma = mask01[p];
    }
    const range = ma - mi || 1;
    for (let p = 0; p < plane; p++) mask01[p] = (mask01[p] - mi) / range;
  }

  // Mask at net resolution: white pixels, matte in alpha.
  const netMask = new OffscreenCanvas(size, size);
  const netCtx = netMask.getContext('2d');
  const maskImg = new ImageData(size, size);
  for (let p = 0; p < plane; p++) {
    const q = p * 4;
    maskImg.data[q] = 255;
    maskImg.data[q + 1] = 255;
    maskImg.data[q + 2] = 255;
    maskImg.data[q + 3] = Math.max(0, Math.min(255, Math.round(mask01[p] * 255)));
  }
  netCtx.putImageData(maskImg, 0, 0);

  // Crop the image region (undo letterbox padding) and scale back to source
  // dimensions (canvas interpolation smooths the matte).
  const out = new OffscreenCanvas(imageData.width, imageData.height);
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  outCtx.drawImage(netMask, region.dx, region.dy, region.dw, region.dh, 0, 0, out.width, out.height);
  const maskData = outCtx.getImageData(0, 0, out.width, out.height);

  return { maskData, backend: entry.backend };
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

self.onmessage = async (e) => {
  const { id, cmd, modelKey, imageData } = e.data;
  if (cmd !== 'segment') return;
  try {
    const onProgress = (info) => self.postMessage({ id, type: 'progress', info });
    const { maskData, backend: usedBackend } = await segment(modelKey, imageData, onProgress);
    self.postMessage({ id, type: 'done', maskData, backend: usedBackend }, [maskData.data.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
