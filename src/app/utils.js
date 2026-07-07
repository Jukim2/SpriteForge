// Generic helpers (leaf module: no app imports)

// Debounce helper to prevent heavy calculations on every keystroke
export function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

export function detectCornerColor(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 0 || h <= 0) return '#00ff00';

    const corners = [
      ctx.getImageData(0, 0, 1, 1).data,
      ctx.getImageData(w - 1, 0, 1, 1).data,
      ctx.getImageData(0, h - 1, 1, 1).data,
      ctx.getImageData(w - 1, h - 1, 1, 1).data
    ];

    let bestIdx = 0;
    let minSumDist = Infinity;
    for (let i = 0; i < 4; i++) {
      let sumDist = 0;
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const rDiff = corners[i][0] - corners[j][0];
        const gDiff = corners[i][1] - corners[j][1];
        const bDiff = corners[i][2] - corners[j][2];
        sumDist += Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff);
      }
      if (sumDist < minSumDist) {
        minSumDist = sumDist;
        bestIdx = i;
      }
    }

    const r = corners[bestIdx][0];
    const g = corners[bestIdx][1];
    const b = corners[bestIdx][2];

    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => {
      const hex = v.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');

    return rgbToHex(r, g, b);
  } catch (err) {
    console.error('Failed to detect corner color:', err);
    return '#00ff00';
  }
}

/**
 * Encodes a canvas to a Blob. WebP uses the browser's native encoder
 * (canvas.toBlob 'image/webp') — no dependency needed. quality is 1-100.
 */
export function encodeCanvasToBlob(canvas, format, quality) {
  const mime = format === 'webp' ? 'image/webp' : 'image/png';
  const q = format === 'webp' ? Math.max(0.01, Math.min(1, (quality || 90) / 100)) : undefined;
  return new Promise(resolve => canvas.toBlob(resolve, mime, q));
}

export function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

export function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
