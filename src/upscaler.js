/**
 * PNG Upscaling Engine
 *
 * Four algorithms, chosen by content type:
 *
 * - 'nearest'  : Integer nearest-neighbor. Perfectly crisp for pixel art when
 *                you just need bigger pixels (no interpolation artifacts).
 * - 'xbr'      : xBR pattern-recognition scaling (2x/3x/4x). The reference
 *                algorithm for smoothing pixel-art edges while preserving
 *                detail. Full alpha support.
 * - 'smooth'   : pica MKS2013 resampling (resize + sharpen in one pass) for
 *                smooth/painted art and photos. Arbitrary scale factors.
 * - 'ai'       : Real-ESRGAN x4 super-resolution via onnxruntime-web (local
 *                inference, models bundled in /models). Best quality for
 *                illustrated/rendered art. Runs on WebGPU when available
 *                (full-size RRDBNet models stay fast), falling back to WASM
 *                (CPU) otherwise. Tiled inference keeps memory flat; alpha is
 *                handled via edge-bleed + separate high-quality resampling of
 *                the alpha channel.
 */

import Pica from 'pica';
import { xbr2x, xbr3x, xbr4x } from 'xbr-js';

const pica = new Pica();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getImageData(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Nearest neighbor
// ---------------------------------------------------------------------------

export function upscaleNearest(sourceCanvas, scale) {
  const out = createCanvas(Math.round(sourceCanvas.width * scale), Math.round(sourceCanvas.height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, out.width, out.height);
  return out;
}

// ---------------------------------------------------------------------------
// xBR (pixel art)
// ---------------------------------------------------------------------------

export function upscaleXbr(sourceCanvas, scale) {
  const factor = Math.round(scale);
  if (![2, 3, 4].includes(factor)) {
    throw new Error('xBR supports 2x, 3x or 4x scaling.');
  }
  const { width, height } = sourceCanvas;
  const imageData = getImageData(sourceCanvas);
  // ImageData is RGBA byte order; viewing it as little-endian Uint32 gives the
  // 0xAABBGGRR layout xbr-js expects.
  const pixels = new Uint32Array(imageData.data.buffer);

  const fn = factor === 2 ? xbr2x : factor === 3 ? xbr3x : xbr4x;
  const scaled = fn(pixels, width, height, { blendColors: true, scaleAlpha: true });

  const out = createCanvas(width * factor, height * factor);
  const outData = new ImageData(
    new Uint8ClampedArray(scaled.buffer, scaled.byteOffset, scaled.length * 4),
    width * factor,
    height * factor
  );
  out.getContext('2d').putImageData(outData, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Smooth resampling (pica MKS2013)
// ---------------------------------------------------------------------------

export async function upscaleSmooth(sourceCanvas, scale) {
  const out = createCanvas(Math.round(sourceCanvas.width * scale), Math.round(sourceCanvas.height * scale));
  await pica.resize(sourceCanvas, out, { filter: 'mks2013', alpha: true });
  return out;
}

// ---------------------------------------------------------------------------
// AI super-resolution (Real-ESRGAN x4, onnxruntime-web)
// ---------------------------------------------------------------------------

export const AI_MODELS = {
  'anime-best': {
    label: 'Illustration / Game Art — Best',
    file: 'models/realesrgan-x4plus-anime6b.onnx', // official RealESRGAN_x4plus_anime_6B
    scale: 4
  },
  'general-best': {
    label: 'General / Photo — Best',
    file: 'models/realesrgan-x4plus.onnx', // official RealESRGAN_x4plus (23-block)
    scale: 4
  },
  anime: {
    label: 'Illustration / Game Art — Fast',
    file: 'models/realesrgan-x4-anime.onnx',
    scale: 4
  },
  general: {
    label: 'General / Photo — Fast',
    file: 'models/realesrgan-x4-general.onnx',
    scale: 4
  }
};

const sessions = {};
let ortModule = null;
let aiBackend = null; // 'webgpu' | 'wasm', resolved on first use

/** Which execution backend AI inference resolved to ('webgpu' or 'wasm'). */
export function getAiBackend() {
  return aiBackend;
}

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
    // Both bundles embed their loaders and resolve the .wasm binary relative
    // to their own module URL, so inference runs fully offline. The webgpu
    // bundle also contains the wasm EP, which we use as a runtime fallback.
    if (await detectWebGpu()) {
      ortModule = await import('onnxruntime-web/webgpu');
      aiBackend = 'webgpu';
    } else {
      ortModule = await import('onnxruntime-web/wasm');
      aiBackend = 'wasm';
    }
  }
  return ortModule;
}

async function getSession(modelKey, onProgress) {
  if (sessions[modelKey]) return sessions[modelKey];

  const model = AI_MODELS[modelKey];
  if (!model) throw new Error(`Unknown AI model: ${modelKey}`);

  const ort = await getOrt();
  if (onProgress) onProgress({ label: 'Loading AI model...', percent: 0 });

  const url = new URL(model.file, window.location.href).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load AI model (${response.status})`);
  const buffer = await response.arrayBuffer();

  const create = (eps) => ort.InferenceSession.create(buffer, {
    executionProviders: eps,
    graphOptimizationLevel: 'all'
  });

  if (aiBackend === 'webgpu') {
    try {
      sessions[modelKey] = await create(['webgpu']);
    } catch (err) {
      console.warn('WebGPU session creation failed, falling back to WASM:', err);
      aiBackend = 'wasm';
      sessions[modelKey] = await create(['wasm']);
    }
  } else {
    sessions[modelKey] = await create(['wasm']);
  }
  return sessions[modelKey];
}

/**
 * Bleeds opaque edge colors into fully transparent regions so the RGB the
 * network sees near sprite borders is meaningful instead of black, preventing
 * dark halos in the upscaled result. Runs a few dilation passes.
 */
function bleedEdgeColors(imageData, passes = 6) {
  const { data, width, height } = imageData;
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) alpha[p] = data[p * 4 + 3];

  let frontier = new Uint8Array(width * height); // 1 = has valid color
  for (let p = 0; p < width * height; p++) frontier[p] = alpha[p] > 0 ? 1 : 0;

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
          data[q] = rSum / n;
          data[q + 1] = gSum / n;
          data[q + 2] = bSum / n;
          next[p] = 1;
          changed = true;
        }
      }
    }
    frontier = next;
    if (!changed) break;
  }
}

/**
 * Runs one tile (RGB, 0..1 NCHW) through the network and returns upscaled RGB.
 */
async function runTile(session, ort, rgba, tileW, tileH, modelScale) {
  const input = new Float32Array(3 * tileW * tileH);
  const plane = tileW * tileH;
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
    throw new Error(`Unexpected AI output size ${outW}x${outH} for ${tileW}x${tileH} input.`);
  }
  return { data: out.data, width: outW, height: outH };
}

/**
 * AI upscale with tiled inference.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {string} modelKey - key of AI_MODELS
 * @param {(info: {label: string, percent: number}) => void} [onProgress]
 * @returns {Promise<HTMLCanvasElement>} canvas upscaled by the model's factor (4x)
 */
export async function upscaleAI(sourceCanvas, modelKey, onProgress) {
  const model = AI_MODELS[modelKey];
  const session = await getSession(modelKey, onProgress);
  const ort = await getOrt();
  const modelScale = model.scale;

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  // Work on a copy: edge bleed mutates RGB under transparent pixels.
  const workCanvas = createCanvas(srcW, srcH);
  workCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
  const workData = getImageData(workCanvas);

  const hasAlpha = (() => {
    const d = workData.data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 255) return true;
    }
    return false;
  })();

  if (hasAlpha) bleedEdgeColors(workData);

  // Tiling: padded borders are discarded after inference so tile seams are
  // invisible. WebGPU affords bigger tiles (fewer seams, better throughput)
  // and more context padding.
  const TILE = aiBackend === 'webgpu' ? 192 : 128;
  const PAD = aiBackend === 'webgpu' ? 16 : 8;

  const outW = srcW * modelScale;
  const outH = srcH * modelScale;
  const outImage = new ImageData(outW, outH);

  const tilesX = Math.ceil(srcW / TILE);
  const tilesY = Math.ceil(srcH / TILE);
  const totalTiles = tilesX * tilesY;
  let doneTiles = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const coreX = tx * TILE;
      const coreY = ty * TILE;
      const coreW = Math.min(TILE, srcW - coreX);
      const coreH = Math.min(TILE, srcH - coreY);

      const padX0 = Math.min(PAD, coreX);
      const padY0 = Math.min(PAD, coreY);
      const padX1 = Math.min(PAD, srcW - coreX - coreW);
      const padY1 = Math.min(PAD, srcH - coreY - coreH);

      const tileX = coreX - padX0;
      const tileY = coreY - padY0;
      const tileW = coreW + padX0 + padX1;
      const tileH = coreH + padY0 + padY1;

      // Extract padded tile RGBA
      const tileRgba = new Uint8ClampedArray(tileW * tileH * 4);
      for (let y = 0; y < tileH; y++) {
        const srcOff = ((tileY + y) * srcW + tileX) * 4;
        tileRgba.set(workData.data.subarray(srcOff, srcOff + tileW * 4), y * tileW * 4);
      }

      const result = await runTile(session, ort, tileRgba, tileW, tileH, modelScale);

      // Copy core region (discarding padding) into output
      const s = modelScale;
      for (let y = 0; y < coreH * s; y++) {
        const srcRow = (padY0 * s + y);
        const dstRow = coreY * s + y;
        for (let x = 0; x < coreW * s; x++) {
          const srcCol = padX0 * s + x;
          const dstCol = coreX * s + x;
          const plane = result.width * result.height;
          const sp = srcRow * result.width + srcCol;
          const dp = (dstRow * outW + dstCol) * 4;
          outImage.data[dp] = Math.max(0, Math.min(1, result.data[sp])) * 255;
          outImage.data[dp + 1] = Math.max(0, Math.min(1, result.data[plane + sp])) * 255;
          outImage.data[dp + 2] = Math.max(0, Math.min(1, result.data[2 * plane + sp])) * 255;
          outImage.data[dp + 3] = 255;
        }
      }

      doneTiles++;
      if (onProgress) {
        onProgress({
          label: `AI upscaling tile ${doneTiles}/${totalTiles}...`,
          percent: Math.round((doneTiles / totalTiles) * 100)
        });
      }
      // Let the UI breathe between tiles.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const out = createCanvas(outW, outH);
  out.getContext('2d').putImageData(outImage, 0, 0);

  // Recombine alpha: upscale the original alpha channel with high-quality
  // resampling and apply it over the AI RGB result.
  if (hasAlpha) {
    const alphaCanvas = createCanvas(srcW, srcH);
    const alphaCtx = alphaCanvas.getContext('2d');
    const alphaImg = alphaCtx.createImageData(srcW, srcH);
    const src = getImageData(sourceCanvas).data;
    for (let p = 0; p < srcW * srcH; p++) {
      const a = src[p * 4 + 3];
      alphaImg.data[p * 4] = a;
      alphaImg.data[p * 4 + 1] = a;
      alphaImg.data[p * 4 + 2] = a;
      alphaImg.data[p * 4 + 3] = 255;
    }
    alphaCtx.putImageData(alphaImg, 0, 0);

    const alphaBig = createCanvas(outW, outH);
    await pica.resize(alphaCanvas, alphaBig, { filter: 'mks2013', alpha: false });
    const alphaData = getImageData(alphaBig).data;

    const outCtx = out.getContext('2d');
    const finalImg = outCtx.getImageData(0, 0, outW, outH);
    for (let p = 0; p < outW * outH; p++) {
      finalImg.data[p * 4 + 3] = alphaData[p * 4];
    }
    outCtx.putImageData(finalImg, 0, 0);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Upscales a canvas with the requested algorithm and integer scale factor.
 * AI models natively produce 4x; other factors are derived by resampling the
 * 4x result down (2x/3x), which preserves the AI detail gain.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {Object} options
 * @param {'nearest'|'xbr'|'smooth'|'ai'} options.algorithm
 * @param {number} options.scale - 2, 3 or 4
 * @param {string} [options.aiModel='anime'] - AI_MODELS key
 * @param {(info: {label: string, percent: number}) => void} [options.onProgress]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function upscaleImage(sourceCanvas, { algorithm, scale, aiModel = 'anime', onProgress }) {
  switch (algorithm) {
    case 'nearest':
      return upscaleNearest(sourceCanvas, scale);
    case 'xbr':
      return upscaleXbr(sourceCanvas, scale);
    case 'smooth':
      return upscaleSmooth(sourceCanvas, scale);
    case 'ai': {
      const model = AI_MODELS[aiModel] || AI_MODELS.anime;
      const native = await upscaleAI(sourceCanvas, aiModel in AI_MODELS ? aiModel : 'anime', onProgress);
      if (scale === model.scale) return native;
      if (onProgress) onProgress({ label: 'Resampling to target scale...', percent: 100 });
      return upscaleSmooth(native, scale / model.scale);
    }
    default:
      throw new Error(`Unknown upscale algorithm: ${algorithm}`);
  }
}
