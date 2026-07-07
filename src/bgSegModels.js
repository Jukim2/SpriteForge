/**
 * Advanced background-segmentation model registry.
 *
 * Shared between the main thread (UI) and the inference worker.
 * Preprocessing/postprocessing per model follows each model's canonical
 * reference implementation (rembg sessions / SkyTNT's demo app).
 */

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

export const BG_SEG_MODELS = {
  'anime-isnet': {
    label: 'Anime / Game Art — ISNet-Anime',
    shortLabel: 'ISNet-Anime',
    // Same file per backend (fp32).
    urls: {
      webgpu: 'https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx',
      wasm: 'https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx'
    },
    downloadMB: { webgpu: 168, wasm: 168 },
    size: 1024,
    // SkyTNT's own pipeline: plain /255, aspect-preserving letterbox, direct mask.
    mean: [0, 0, 0],
    std: [1, 1, 1],
    sigmoid: false,
    minmax: false,
    letterbox: true
  },
  toonout: {
    label: 'Anime / Game Art — ToonOut (BiRefNet)',
    shortLabel: 'ToonOut',
    // BiRefNet graphs cannot run on the ort-web wasm EP (an op pattern blows
    // the 4GB wasm heap with std::bad_alloc), so this model is WebGPU-only.
    // (BiRefNet_lite from onnx-community is broken even on WebGPU — a jsep
    // shader error — which is why there is no general BiRefNet entry here.)
    webgpuOnly: true,
    urls: {
      webgpu: 'https://huggingface.co/sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout-fp16.onnx'
    },
    downloadMB: { webgpu: 470 },
    size: 1024,
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    sigmoid: false, // sigmoid baked into the export
    minmax: false
  },
  rmbg14: {
    label: 'Photo / Product — RMBG-1.4 (non-commercial)',
    shortLabel: 'RMBG-1.4',
    urls: {
      webgpu: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
      wasm: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx'
    },
    downloadMB: { webgpu: 176, wasm: 176 },
    size: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    sigmoid: false,
    minmax: true
  }
};

export function isSegModel(key) {
  return Object.prototype.hasOwnProperty.call(BG_SEG_MODELS, key);
}
