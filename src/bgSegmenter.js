/**
 * Advanced Background Segmentation Engine (main-thread facade)
 *
 * Runs state-of-the-art open matting/segmentation models locally — an
 * alternative to the bundled imgly ISNet pipeline with meaningfully better
 * edge quality:
 *
 * - 'anime-isnet' : SkyTNT anime-segmentation (ISNet trained on anime).
 *                   The go-to for game art / illustration / sprites.
 * - 'toonout'     : BiRefNet fine-tuned for anime characters (ToonOut,
 *                   arXiv:2509.06839). Best edges on illustrated art.
 *                   WebGPU-only (BiRefNet cannot run on the wasm EP).
 * - 'rmbg14'      : BRIA RMBG-1.4 (photo/product; non-commercial license).
 *
 * Models are too large to bundle, so they are downloaded from Hugging Face
 * on first use and persisted in OPFS — after that the feature works offline.
 * Inference itself never leaves the machine.
 *
 * All ort work happens inside a dedicated module worker (bgSegWorker.js):
 * that isolates our onnxruntime-web from the ort copy that
 * @imgly/background-removal loads (they break each other's WebGPU init when
 * sharing one scope) and keeps the UI thread responsive.
 *
 * Output is an alpha-mask canvas (mask in the alpha channel) at the source
 * image's resolution, ready for `original × mask` composition.
 */

import { BG_SEG_MODELS, isSegModel } from './bgSegModels.js';

export { BG_SEG_MODELS, isSegModel };

let worker = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, onProgress }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./bgSegWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    const req = pending.get(msg.id);
    if (!req) return;
    if (msg.type === 'progress') {
      if (req.onProgress) req.onProgress(msg.info);
      return;
    }
    pending.delete(msg.id);
    if (msg.type === 'error') req.reject(new Error(msg.message));
    else req.resolve(msg);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'Background segmentation worker crashed.');
    for (const req of pending.values()) req.reject(err);
    pending.clear();
    // Drop the crashed worker; the next request spawns a fresh one.
    try { worker.terminate(); } catch { /* best effort */ }
    worker = null;
  };
  return worker;
}

/** True if the model for this key is already in the local OPFS cache. */
export async function isSegModelCached(modelKey) {
  const spec = BG_SEG_MODELS[modelKey];
  if (!spec) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('spriteforge-bg-models', { create: true });
    const url = spec.urls.webgpu || spec.urls.wasm;
    await dir.getFileHandle(url.replace(/[^a-zA-Z0-9._-]/g, '_'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Segments the foreground of a canvas and returns the mask as a canvas whose
 * ALPHA channel holds the matte, scaled to the source canvas's dimensions.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {string} modelKey - key of BG_SEG_MODELS
 * @param {(info: {label: string, percent?: number}) => void} [onProgress]
 * @returns {Promise<{mask: HTMLCanvasElement, backend: 'webgpu'|'wasm'}>}
 */
export async function segmentBackground(sourceCanvas, modelKey, onProgress) {
  if (!isSegModel(modelKey)) throw new Error(`Unknown segmentation model: ${modelKey}`);

  const w = getWorker();
  const id = ++seq;
  const imageData = sourceCanvas
    .getContext('2d')
    .getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, cmd: 'segment', modelKey, imageData }, [imageData.data.buffer]);
  });

  const mask = document.createElement('canvas');
  mask.width = sourceCanvas.width;
  mask.height = sourceCanvas.height;
  mask.getContext('2d').putImageData(result.maskData, 0, 0);

  return { mask, backend: result.backend };
}
