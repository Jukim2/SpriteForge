/**
 * PNG -> SVG Vectorization Engine
 *
 * Two complementary modes:
 *
 * - 'pixel'  : Pixel-perfect vectorization for pixel art. Every pixel is
 *              reproduced exactly using greedy rectangle meshing (adjacent
 *              same-color pixels merge into maximal rectangles, one <path> per
 *              color). Output scales infinitely with zero blur and is exact.
 *
 * - 'trace'  : Smooth contour tracing (VTracer, visioncortex WASM) for
 *              illustrations, logos and painted art. Hierarchical color
 *              clustering + spline fitting — significantly cleaner curves and
 *              color separation than classic JS tracers.
 */

function getImageData(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Pixel-perfect mode
// ---------------------------------------------------------------------------

/**
 * Greedy rectangle meshing: for each distinct RGBA color, merges pixels into
 * as few rectangles as possible (expand right, then down).
 */
function buildColorRects(imageData) {
  const { data, width, height } = imageData;
  const visited = new Uint8Array(width * height);
  const rectsByColor = new Map(); // colorKey -> array of [x, y, w, h]

  const colorAt = (p) => {
    const i = p * 4;
    // Fully transparent pixels are background regardless of RGB.
    if (data[i + 3] === 0) return -1;
    return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (visited[p]) continue;
      const color = colorAt(p);
      if (color === -1) {
        visited[p] = 1;
        continue;
      }

      // Expand right
      let w = 1;
      while (x + w < width && !visited[p + w] && colorAt(p + w) === color) w++;

      // Expand down while the whole row matches
      let h = 1;
      outer: while (y + h < height) {
        const rowStart = (y + h) * width + x;
        for (let k = 0; k < w; k++) {
          if (visited[rowStart + k] || colorAt(rowStart + k) !== color) break outer;
        }
        h++;
      }

      for (let dy = 0; dy < h; dy++) {
        visited.fill(1, (y + dy) * width + x, (y + dy) * width + x + w);
      }

      let list = rectsByColor.get(color);
      if (!list) {
        list = [];
        rectsByColor.set(color, list);
      }
      list.push([x, y, w, h]);
    }
  }

  return rectsByColor;
}

function colorKeyToCss(color) {
  const r = (color >>> 24) & 0xff;
  const g = (color >>> 16) & 0xff;
  const b = (color >>> 8) & 0xff;
  const a = color & 0xff;
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  return { hex, opacity: a / 255 };
}

/**
 * Pixel-perfect SVG. Each color becomes a single <path> of merged rectangles.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} [options]
 * @param {number} [options.scale=1] - Output unit multiplier (viewBox stays 1:1 per pixel)
 * @returns {string} SVG markup
 */
export function vectorizePixelPerfect(canvas, options = {}) {
  const { scale = 1 } = options;
  const imageData = getImageData(canvas);
  const { width, height } = imageData;
  const rectsByColor = buildColorRects(imageData);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width * scale}" height="${height * scale}" shape-rendering="crispEdges">`
  );

  // Sort colors by coverage (large fills first) for a cleaner document.
  const entries = [...rectsByColor.entries()].sort((a, b) => {
    const areaA = a[1].reduce((s, r) => s + r[2] * r[3], 0);
    const areaB = b[1].reduce((s, r) => s + r[2] * r[3], 0);
    return areaB - areaA;
  });

  for (const [color, rects] of entries) {
    const { hex, opacity } = colorKeyToCss(color);
    let d = '';
    for (const [x, y, w, h] of rects) {
      d += `M${x} ${y}h${w}v${h}h${-w}z`;
    }
    const opacityAttr = opacity < 1 ? ` fill-opacity="${opacity.toFixed(3)}"` : '';
    parts.push(`<path fill="${hex}"${opacityAttr} d="${d}"/>`);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Smooth trace mode
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

// VTracer parameter presets (webapp semantics: thresholds in radians,
// filterSpeckle is an area in px², colorPrecision is significant bits per
// channel, layerDifference is the gradient layering step).
const TRACE_PRESETS = {
  // High fidelity: full color precision, keep small details, tight curves.
  detailed: {
    colorPrecision: 8,
    layerDifference: 8,
    filterSpeckle: 2,
    cornerThreshold: 60 * DEG,
    lengthThreshold: 3.5,
    spliceThreshold: 45 * DEG,
    pathPrecision: 3
  },
  // Balanced default (matches vtracer's own defaults).
  balanced: {
    colorPrecision: 6,
    layerDifference: 16,
    filterSpeckle: 16,
    cornerThreshold: 60 * DEG,
    lengthThreshold: 4,
    spliceThreshold: 45 * DEG,
    pathPrecision: 2
  },
  // Simplified poster look: few colors, aggressive speckle removal.
  simplified: {
    colorPrecision: 4,
    layerDifference: 32,
    filterSpeckle: 64,
    cornerThreshold: 70 * DEG,
    lengthThreshold: 6,
    spliceThreshold: 45 * DEG,
    pathPrecision: 2
  }
};

// ---------------------------------------------------------------------------
// VTracer WASM loading (wasm-pack bundler target, instantiated manually so no
// extra Vite plugins are needed).
// ---------------------------------------------------------------------------

let vtracerPromise = null;

async function getVtracer() {
  if (!vtracerPromise) {
    vtracerPromise = (async () => {
      const glue = await import('vtracer-webapp/vtracer_webapp_bg.js');
      const wasmUrl = (await import('vtracer-webapp/vtracer_webapp_bg.wasm?url')).default;
      const imports = { './vtracer_webapp_bg.js': glue };
      let instance;
      try {
        ({ instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports));
      } catch {
        // Server didn't send application/wasm — fall back to ArrayBuffer.
        const bytes = await (await fetch(wasmUrl)).arrayBuffer();
        ({ instance } = await WebAssembly.instantiate(bytes, imports));
      }
      glue.__wbg_set_wasm(instance.exports);
      instance.exports.__wbindgen_start();
      return glue;
    })();
  }
  return vtracerPromise;
}

let vtracerRunId = 0;

/**
 * The bundled vtracer wasm build has no transparency keying, so fully
 * transparent pixels would trace as black. We key them ourselves: fill with a
 * color that does not occur in the image, then strip the traced paths of that
 * color from the output. Returns the key as {r,g,b} or null if opaque.
 */
function keyOutTransparency(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  let hasTransparency = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) { hasTransparency = true; break; }
  }
  if (!hasTransparency) return null;

  // Pick the candidate color farthest from every color used in the image, so
  // color quantization cannot merge real content into the keyed cluster.
  const candidates = [
    [255, 0, 255], [0, 255, 0], [0, 255, 255], [255, 128, 0],
    [128, 0, 255], [255, 255, 0], [0, 128, 255], [255, 0, 0]
  ];
  let best = candidates[0];
  let bestDist = -1;
  for (const [cr, cg, cb] of candidates) {
    let minDist = Infinity;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const d = (data[i] - cr) ** 2 + (data[i + 1] - cg) ** 2 + (data[i + 2] - cb) ** 2;
      if (d < minDist) minDist = d;
      if (minDist === 0) break;
    }
    if (minDist > bestDist) {
      bestDist = minDist;
      best = [cr, cg, cb];
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      data[i] = best[0];
      data[i + 1] = best[1];
      data[i + 2] = best[2];
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return { r: best[0], g: best[1], b: best[2] };
}

/** Removes traced paths whose fill is (close to) the transparency key color. */
function stripKeyPaths(svgEl, key) {
  for (const path of [...svgEl.querySelectorAll('path')]) {
    const m = /fill:\s*#([0-9a-f]{6})/i.exec(path.getAttribute('style') || '');
    if (!m) continue;
    const v = parseInt(m[1], 16);
    const dr = ((v >> 16) & 0xff) - key.r;
    const dg = ((v >> 8) & 0xff) - key.g;
    const db = (v & 0xff) - key.b;
    if (dr * dr + dg * dg + db * db < 48 * 48) path.remove();
  }
}

/**
 * Smooth color tracing via VTracer (visioncortex).
 *
 * The wasm converter reads its input from a canvas element and prepends the
 * traced paths into an svg element, both looked up by DOM id — so hidden
 * host elements are mounted for the duration of the conversion.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} [options]
 * @param {'detailed'|'balanced'|'simplified'} [options.preset='balanced']
 * @param {number} [options.colors] - Per-channel color precision in bits (1-8)
 * @param {number} [options.scale=1] - Output size multiplier
 * @param {(info: {label: string, percent: number}) => void} [options.onProgress]
 * @returns {Promise<string>} SVG markup
 */
export async function vectorizeTrace(canvas, options = {}) {
  const { preset = 'balanced', colors, scale = 1, onProgress } = options;
  const p = { ...(TRACE_PRESETS[preset] || TRACE_PRESETS.balanced) };
  if (colors) {
    p.colorPrecision = Math.max(1, Math.min(8, Math.round(colors)));
  }

  const glue = await getVtracer();
  const { width, height } = canvas;

  const id = ++vtracerRunId;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
  const workCanvas = document.createElement('canvas');
  workCanvas.id = `vtracer-canvas-${id}`;
  workCanvas.width = width;
  workCanvas.height = height;
  const workCtx = workCanvas.getContext('2d');
  workCtx.drawImage(canvas, 0, 0);
  const transparencyKey = keyOutTransparency(workCtx, width, height);
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.id = `vtracer-svg-${id}`;
  host.appendChild(workCanvas);
  host.appendChild(svgEl);
  document.body.appendChild(host);

  let converter = null;
  try {
    converter = glue.ColorImageConverter.new_with_string(JSON.stringify({
      canvas_id: workCanvas.id,
      svg_id: svgEl.id,
      mode: 'spline',
      hierarchical: 'stacked',
      corner_threshold: p.cornerThreshold,
      length_threshold: p.lengthThreshold,
      max_iterations: 10,
      splice_threshold: p.spliceThreshold,
      filter_speckle: p.filterSpeckle,
      color_precision: 8 - p.colorPrecision, // webapp passes the inverse (merge distance)
      layer_difference: p.layerDifference,
      path_precision: p.pathPrecision
    }));
    converter.init();

    let done = false;
    while (!done) {
      const sliceStart = performance.now();
      while (!(done = converter.tick()) && performance.now() - sliceStart < 30) { /* time-sliced */ }
      if (onProgress) {
        onProgress({ label: `Tracing... ${converter.progress()}%`, percent: converter.progress() });
      }
      if (!done) await new Promise(r => setTimeout(r, 0));
    }

    if (transparencyKey) stripKeyPaths(svgEl, transparencyKey);
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgEl.setAttribute('width', `${width * scale}`);
    svgEl.setAttribute('height', `${height * scale}`);
    return new XMLSerializer().serializeToString(svgEl);
  } finally {
    if (converter) converter.free();
    host.remove();
  }
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 * @param {'pixel'|'trace'} options.mode
 * @param {string} [options.preset] - trace preset
 * @param {number} [options.colors] - trace palette size
 * @param {number} [options.scale=1]
 * @param {(info: {label: string, percent: number}) => void} [options.onProgress]
 * @returns {Promise<string>} SVG markup
 */
export async function vectorizeImage(canvas, { mode, preset, colors, scale = 1, onProgress }) {
  if (mode === 'pixel') {
    return vectorizePixelPerfect(canvas, { scale });
  }
  return vectorizeTrace(canvas, { preset, colors, scale, onProgress });
}

/**
 * Renders an SVG string to a data URL for <img> previews.
 */
export function svgToDataUrl(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
