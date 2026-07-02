/**
 * Sprite Sheet Slicing Core Algorithms
 */

/**
 * Checks if a specific region in the image is empty (fully transparent).
 * @param {CanvasRenderingContext2D} ctx 
 * @param {number} x 
 * @param {number} y 
 * @param {number} width 
 * @param {number} height 
 * @param {number} alphaThreshold 
 * @returns {boolean}
 */
export function isRegionEmpty(ctx, x, y, width, height, alphaThreshold = 5) {
  if (width <= 0 || height <= 0) return true;
  
  // Guard against out-of-bounds
  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;
  const targetX = Math.max(0, Math.min(x, canvasWidth - 1));
  const targetY = Math.max(0, Math.min(y, canvasHeight - 1));
  const targetW = Math.min(width, canvasWidth - targetX);
  const targetH = Math.min(height, canvasHeight - targetY);

  if (targetW <= 0 || targetH <= 0) return true;

  const imgData = ctx.getImageData(targetX, targetY, targetW, targetH);
  const data = imgData.data;

  // Check every 4th value (alpha channel)
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] >= alphaThreshold) {
      return false; // Found a non-transparent pixel
    }
  }
  return true;
}

/**
 * Slices the sprite sheet using a regular grid.
 * @param {HTMLImageElement} image 
 * @param {number} spriteWidth 
 * @param {number} spriteHeight 
 * @param {boolean} skipEmpty 
 * @param {number} alphaThreshold 
 * @returns {Array} List of slice objects
 */
export function sliceGrid(image, spriteWidth, spriteHeight, skipEmpty = true, alphaThreshold = 5) {
  const slices = [];
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // Setup temporary canvas to read pixel data
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const cols = Math.floor(width / spriteWidth);
  const rows = Math.floor(height / spriteHeight);
  let id = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * spriteWidth;
      const y = r * spriteHeight;

      const empty = isRegionEmpty(ctx, x, y, spriteWidth, spriteHeight, alphaThreshold);
      if (skipEmpty && empty) {
        continue;
      }

      slices.push({
        id: id++,
        x,
        y,
        width: spriteWidth,
        height: spriteHeight,
        row: r,
        col: c,
        isEmpty: empty,
        enabled: true // user can toggle this in the UI
      });
    }
  }

  return slices;
}

/**
 * Slices a custom rectangular region using user-defined divider lines.
 * Unlike sliceGrid which uses uniform cell sizes, this allows non-uniform cells
 * defined by manually adjustable vertical and horizontal divider positions.
 * 
 * @param {HTMLImageElement|HTMLCanvasElement} image - Source image or canvas
 * @param {Object} region - The bounding region { x, y, width, height }
 * @param {number[]} colLines - Array of x-coordinates for vertical dividers (relative to image, sorted ascending)
 * @param {number[]} rowLines - Array of y-coordinates for horizontal dividers (relative to image, sorted ascending)
 * @param {boolean} skipEmpty - Whether to skip fully transparent cells
 * @param {number} alphaThreshold - Alpha threshold for transparency check
 * @returns {Array} List of slice objects
 */
export function sliceCustomGrid(image, region, colLines, rowLines, skipEmpty = true, alphaThreshold = 5) {
  const slices = [];
  const imgWidth = image.naturalWidth || image.width;
  const imgHeight = image.naturalHeight || image.height;

  // Setup temporary canvas to read pixel data
  const canvas = document.createElement('canvas');
  canvas.width = imgWidth;
  canvas.height = imgHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  // Build x-boundaries: [region.x, ...colLines, region.x + region.width]
  const xBounds = [region.x, ...colLines, region.x + region.width].map(v => Math.round(v));
  // Build y-boundaries: [region.y, ...rowLines, region.y + region.height]
  const yBounds = [region.y, ...rowLines, region.y + region.height].map(v => Math.round(v));

  const numCols = xBounds.length - 1;
  const numRows = yBounds.length - 1;
  let id = 0;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const x = xBounds[c];
      const y = yBounds[r];
      const w = xBounds[c + 1] - x;
      const h = yBounds[r + 1] - y;

      if (w <= 0 || h <= 0) continue;

      const empty = isRegionEmpty(ctx, x, y, w, h, alphaThreshold);
      if (skipEmpty && empty) {
        continue;
      }

      slices.push({
        id: id++,
        x,
        y,
        width: w,
        height: h,
        row: r,
        col: c,
        isEmpty: empty,
        enabled: true
      });
    }
  }

  return slices;
}

/**
 * Merges bounding boxes that are within `gap` pixels of each other, so sprites
 * made of disconnected parts (detached shadows, particles, floating limbs)
 * are detected as a single sprite. Repeats until no more merges happen.
 * @param {Array} boxes - Array of {x, y, width, height}
 * @param {number} gap - Max pixel distance between boxes to merge (0 disables)
 * @returns {Array} Merged boxes
 */
function mergeNearbyBoxes(boxes, gap) {
  if (gap <= 0 || boxes.length < 2) return boxes;

  let merged = boxes.map(b => ({ ...b }));
  let changed = true;

  while (changed) {
    changed = false;
    const result = [];

    for (const box of merged) {
      let target = null;
      for (const r of result) {
        // Expand one box by the gap so `gap` means actual max distance between boxes.
        const overlapX = box.x < r.x + r.width + gap && box.x + box.width > r.x - gap;
        const overlapY = box.y < r.y + r.height + gap && box.y + box.height > r.y - gap;
        if (overlapX && overlapY) {
          target = r;
          break;
        }
      }

      if (target) {
        const minX = Math.min(target.x, box.x);
        const minY = Math.min(target.y, box.y);
        const maxX = Math.max(target.x + target.width, box.x + box.width);
        const maxY = Math.max(target.y + target.height, box.y + box.height);
        target.x = minX;
        target.y = minY;
        target.width = maxX - minX;
        target.height = maxY - minY;
        changed = true;
      } else {
        result.push(box);
      }
    }

    merged = result;
  }

  return merged;
}

/**
 * Automatically detects sprite bounding boxes using Connected Component Labeling.
 * @param {HTMLImageElement} image
 * @param {number} minWidth Minimum width of a valid sprite
 * @param {number} minHeight Minimum height of a valid sprite
 * @param {number} alphaThreshold Alpha threshold to consider pixel as solid (0-255)
 * @param {number} rowYThreshold Y distance within which sprites are grouped into the same row
 * @param {number} mergeGap Distance (px) within which separate components are merged into one sprite
 * @returns {Array} List of detected slice objects
 */
export function sliceAuto(image, minWidth = 8, minHeight = 8, alphaThreshold = 5, rowYThreshold = 12, mergeGap = 0) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // Setup temporary canvas to read pixel data
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // visited array to keep track of processed pixels
  const visited = new Uint8Array(width * height);
  const detectedBoxes = [];

  // Helper to check pixel alpha
  const getAlpha = (x, y) => data[(y * width + x) * 4 + 3];

  // Connected Component Labeling using BFS (avoiding recursion limits)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || getAlpha(x, y) < alphaThreshold) {
        continue;
      }

      // Start of a new component
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      const queue = [x, y];
      visited[idx] = 1;
      let head = 0;

      while (head < queue.length) {
        const cx = queue[head++];
        const cy = queue[head++];

        // Update bounding box
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // Check 8-connected neighbors
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = ny * width + nx;
              if (!visited[nidx] && getAlpha(nx, ny) >= alphaThreshold) {
                visited[nidx] = 1;
                queue.push(nx, ny);
              }
            }
          }
        }
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;

      // Keep every component here; size filtering happens after merging so
      // small fragments (particles, shadows) can still merge into a parent.
      detectedBoxes.push({
        x: minX,
        y: minY,
        width: boxW,
        height: boxH,
        isEmpty: false,
        enabled: true
      });
    }
  }

  // Merge components that belong to the same sprite, then drop pieces that
  // are still too small to be a valid sprite.
  const mergedBoxes = mergeNearbyBoxes(detectedBoxes, mergeGap)
    .filter(b => b.width >= minWidth && b.height >= minHeight);
  detectedBoxes.length = 0;
  detectedBoxes.push(...mergedBoxes);

  // Row grouping & sorting (Row-Major Order)
  // Group boxes into rows based on overlapping/close Y coordinates.
  const rows = [];
  
  // Sort boxes primarily by Y coordinate
  detectedBoxes.sort((a, b) => a.y - b.y);

  for (const box of detectedBoxes) {
    let addedToRow = false;

    // Check if there is an existing row where Y center or top is close to this box Y
    for (const r of rows) {
      // Find representative Y of the row (average Y)
      const avgY = r.reduce((sum, b) => sum + b.y, 0) / r.length;
      if (Math.abs(box.y - avgY) <= rowYThreshold) {
        r.push(box);
        addedToRow = true;
        break;
      }
    }

    if (!addedToRow) {
      rows.push([box]);
    }
  }

  // Sort rows by average Y, and sort boxes within each row by X coordinate
  rows.sort((rowA, rowB) => {
    const avgYA = rowA.reduce((sum, b) => sum + b.y, 0) / rowA.length;
    const avgYB = rowB.reduce((sum, b) => sum + b.y, 0) / rowB.length;
    return avgYA - avgYB;
  });

  const sortedSlices = [];
  let sliceId = 0;

  rows.forEach((row, rowIndex) => {
    // Sort boxes in this row from left to right
    row.sort((a, b) => a.x - b.x);

    row.forEach((box, colIndex) => {
      sortedSlices.push({
        id: sliceId++,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        row: rowIndex,
        col: colIndex,
        isEmpty: box.isEmpty,
        enabled: box.enabled
      });
    });
  });

  return sortedSlices;
}

/**
 * Automatically predicts the ideal grid size (width and height) by analyzing
 * the bounding boxes of individual sprite components.
 * @param {HTMLImageElement} image 
 * @param {number} alphaThreshold 
 * @returns {Object} { width, height } predicted grid dimensions
 */
export function detectGridSize(image, alphaThreshold = 5) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;

  // Setup temporary canvas to read pixel data
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  const visited = new Uint8Array(width * height);
  const getAlpha = (x, y) => data[(y * width + x) * 4 + 3];

  const widths = [];
  const heights = [];

  // Analyze components via BFS (using 4-connected neighbors to prevent merging)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || getAlpha(x, y) < alphaThreshold) {
        continue;
      }

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      const queue = [x, y];
      visited[idx] = 1;
      let head = 0;

      while (head < queue.length) {
        const cx = queue[head++];
        const cy = queue[head++];

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-connected neighbors
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nidx = ny * width + nx;
            if (!visited[nidx] && getAlpha(nx, ny) >= alphaThreshold) {
              visited[nidx] = 1;
              queue.push(nx, ny);
            }
          }
        }
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;

      // Ignore single pixel noise & huge outliers (merged background or giant textures)
      if (boxW >= 8 && boxH >= 8 && boxW < width * 0.25 && boxH < height * 0.25) {
        widths.push(boxW);
        heights.push(boxH);
      }
    }
  }

  if (widths.length === 0) {
    return { width: 32, height: 32 }; // Return standard fallback
  }

  // Standard grid dimensions in game development
  const standardSizes = [8, 12, 16, 24, 32, 48, 64, 80, 96, 128, 256];
  
  // Find the closest standard size using absolute distance (robust to small bleed/margins)
  const getNearestStandard = (val) => {
    let closest = standardSizes[0];
    let minDiff = Infinity;
    for (const size of standardSizes) {
      const diff = Math.abs(size - val);
      if (diff < minDiff) {
        minDiff = diff;
        closest = size;
      }
    }
    return closest;
  };

  const matchedWidths = widths.map(getNearestStandard);
  const matchedHeights = heights.map(getNearestStandard);

  const getMode = (arr) => {
    const counts = {};
    let mode = arr[0];
    let maxCount = 0;
    arr.forEach(val => {
      counts[val] = (counts[val] || 0) + 1;
      if (counts[val] > maxCount) {
        maxCount = counts[val];
        mode = val;
      }
    });
    return mode;
  };

  return {
    width: getMode(matchedWidths),
    height: getMode(matchedHeights)
  };
}
