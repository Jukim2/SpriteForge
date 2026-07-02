/**
 * Chroma Key Engine
 *
 * Shared color-key background removal used by both the Slicer and Video workspaces.
 * Pipeline: YUV weighted distance keying -> optional contiguous (border flood fill)
 * restriction -> soft feathered alpha -> chroma spill suppression -> edge decontamination.
 */

export function rgbToYuv(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.169 * r - 0.331 * g + 0.500 * b + 128;
  const v = 0.500 * r - 0.419 * g - 0.081 * b + 128;
  return { y, u, v };
}

function yuvToRgb(y, u, v) {
  const uu = u - 128;
  const vv = v - 128;
  return {
    r: y + 1.402 * vv,
    g: y - 0.344136 * uu - 0.714136 * vv,
    b: y + 1.772 * uu
  };
}

/**
 * Flood fill from the image border: marks every pixel connected to the outside
 * whose color is within maxThreshold of the key color (or already transparent).
 * Returns Uint8Array mask (1 = keyable background, 0 = protected foreground).
 */
export function getContiguousBgMask(width, height, data, targetYuv, wY, wU, wV, maxThreshold) {
  const mask = new Uint8Array(width * height);
  const stack = [];

  function checkAndPush(x, y) {
    const idx = y * width + x;
    if (mask[idx] === 0) {
      const pIdx = idx * 4;
      const a = data[pIdx + 3];
      if (a === 0) {
        mask[idx] = 1;
        stack.push(idx);
        return;
      }
      const pixelYuv = rgbToYuv(data[pIdx], data[pIdx + 1], data[pIdx + 2]);
      const dist = Math.sqrt(
        wY * ((pixelYuv.y - targetYuv.y) ** 2) +
        wU * ((pixelYuv.u - targetYuv.u) ** 2) +
        wV * ((pixelYuv.v - targetYuv.v) ** 2)
      );
      if (dist < maxThreshold) {
        mask[idx] = 1;
        stack.push(idx);
      }
    }
  }

  for (let x = 0; x < width; x++) {
    checkAndPush(x, 0);
    checkAndPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    checkAndPush(0, y);
    checkAndPush(width - 1, y);
  }

  while (stack.length > 0) {
    const idx = stack.pop();
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) checkAndPush(x - 1, y);
    if (x < width - 1) checkAndPush(x + 1, y);
    if (y > 0) checkAndPush(x, y - 1);
    if (y < height - 1) checkAndPush(x, y + 1);
  }

  return mask;
}

/**
 * Suppresses key-color spill (e.g. green fringes/reflections) on surviving pixels.
 * Works in YUV space: projects each pixel's chroma onto the key chroma direction
 * and subtracts the positive component, preserving luminance.
 */
function suppressSpill(data, width, height, targetYuv, strength = 0.85) {
  const ku = targetYuv.u - 128;
  const kv = targetYuv.v - 128;
  const kLen = Math.sqrt(ku * ku + kv * kv);
  // Achromatic key (white/black/gray): there is no chroma direction to despill.
  if (kLen < 20) return;
  const kuN = ku / kLen;
  const kvN = kv / kLen;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;

    const yuv = rgbToYuv(data[i], data[i + 1], data[i + 2]);
    const cu = yuv.u - 128;
    const cv = yuv.v - 128;
    const proj = cu * kuN + cv * kvN;
    if (proj <= 0) continue;

    // Scale suppression by how chromatically close the pixel is to the key hue,
    // so pixels merely sharing a slight tint are not washed out.
    const cLen = Math.sqrt(cu * cu + cv * cv) || 1;
    const hueAlignment = proj / cLen; // 0..1 (cosine)
    const amount = proj * strength * hueAlignment * hueAlignment;

    const newU = 128 + cu - amount * kuN;
    const newV = 128 + cv - amount * kvN;
    const rgb = yuvToRgb(yuv.y, newU, newV);
    data[i] = Math.max(0, Math.min(255, rgb.r));
    data[i + 1] = Math.max(0, Math.min(255, rgb.g));
    data[i + 2] = Math.max(0, Math.min(255, rgb.b));
  }
}

/**
 * Replaces the color of semi-transparent edge pixels with the nearest fully
 * opaque neighbor color so PNG edges don't carry background contamination.
 */
export function decontaminateEdges(width, height, data) {
  const temp = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a > 0 && a < 255) {
        let found = false;
        let bestR = 0, bestG = 0, bestB = 0;
        let minDist = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nIdx = ((y + dy) * width + (x + dx)) * 4;
            if (data[nIdx + 3] === 255) {
              const dist = dx * dx + dy * dy;
              if (dist < minDist) {
                minDist = dist;
                bestR = data[nIdx];
                bestG = data[nIdx + 1];
                bestB = data[nIdx + 2];
                found = true;
              }
            }
          }
        }
        if (found) {
          temp[idx] = bestR;
          temp[idx + 1] = bestG;
          temp[idx + 2] = bestB;
        }
      }
    }
  }

  data.set(temp);
}

/**
 * Applies chroma key removal to raw RGBA pixel data in place.
 *
 * @param {Uint8ClampedArray} data - RGBA pixels (modified in place)
 * @param {number} width
 * @param {number} height
 * @param {Object} options
 * @param {string} options.color - Hex key color e.g. '#00ff00'
 * @param {number} options.tolerance - 0-100 UI tolerance
 * @param {boolean} options.contiguous - Restrict removal to border-connected areas
 * @param {number} [options.despill=0.85] - Spill suppression strength (0 disables)
 */
export function applyChromaKey(data, width, height, { color, tolerance, contiguous, despill = 0.85 }) {
  const hex = color || '#00ff00';
  const targetR = parseInt(hex.slice(1, 3), 16);
  const targetG = parseInt(hex.slice(3, 5), 16);
  const targetB = parseInt(hex.slice(5, 7), 16);
  const tol = typeof tolerance === 'number' ? tolerance : 15;

  const targetYuv = rgbToYuv(targetR, targetG, targetB);

  // Saturated keys (green/blue screen) weigh chroma channels higher; neutral
  // keys (white/black) must rely on luminance instead.
  const targetSaturation = Math.sqrt((targetYuv.u - 128) ** 2 + (targetYuv.v - 128) ** 2);
  const sat = Math.min(1.0, targetSaturation / 181.0);
  const wY = 1.0 - (sat * 0.8);
  const wU = 1.0 + (sat * 0.5);
  const wV = 1.0 + (sat * 0.5);

  const toleranceVal = tol * 2.2;
  const minThreshold = toleranceVal;
  const featherWidth = Math.min(15, tol);
  const maxThreshold = toleranceVal + featherWidth;

  const useContiguous = contiguous !== false;
  const mask = useContiguous
    ? getContiguousBgMask(width, height, data, targetYuv, wY, wU, wV, maxThreshold)
    : null;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (useContiguous && mask[p] === 0) continue;

    const pixelYuv = rgbToYuv(data[i], data[i + 1], data[i + 2]);
    const dist = Math.sqrt(
      wY * ((pixelYuv.y - targetYuv.y) ** 2) +
      wU * ((pixelYuv.u - targetYuv.u) ** 2) +
      wV * ((pixelYuv.v - targetYuv.v) ** 2)
    );

    if (dist <= minThreshold) {
      data[i + 3] = 0;
    } else if (dist < maxThreshold) {
      const range = maxThreshold - minThreshold;
      const t = range > 0 ? (dist - minThreshold) / range : 1.0;
      data[i + 3] = Math.min(data[i + 3], Math.floor(t * 255));
    }
  }

  if (despill > 0) {
    suppressSpill(data, width, height, targetYuv, despill);
  }

  decontaminateEdges(width, height, data);
}

/**
 * Convenience wrapper: keys out the background of a source canvas/image and
 * draws the result into targetCtx (cleared first).
 */
export function chromaKeyCanvas(sourceCanvas, targetCtx, options) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  targetCtx.clearRect(0, 0, width, height);
  targetCtx.drawImage(sourceCanvas, 0, 0);
  const imgData = targetCtx.getImageData(0, 0, width, height);
  applyChromaKey(imgData.data, width, height, options);
  targetCtx.putImageData(imgData, 0, 0);
}
