// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { state, getActiveFile } from '../../app/state.js';
import { els, ctx } from '../../app/dom.js';
import { updateExportStats } from '../exporter.js';
import { syncSettingsFromUI } from './settings.js';
import { sliceFile, reSliceActiveFile } from './process.js';
import { drawCanvas } from './canvas.js';
import { renderPreviews } from './previews.js';

// ----------------------------------------------------
// Custom Grid Functions
// ----------------------------------------------------

/** Sync custom region from the numeric inputs */
export function syncCustomRegionFromUI() {
  const x = Math.max(0, parseInt(els.customRegionX.value) || 0);
  const y = Math.max(0, parseInt(els.customRegionY.value) || 0);
  const w = Math.max(1, parseInt(els.customRegionW.value) || 1);
  const h = Math.max(1, parseInt(els.customRegionH.value) || 1);
  state.activeSettings.customRegion = { x, y, width: w, height: h };
}

/** Update the region numeric inputs from state */
function syncCustomRegionToUI() {
  const r = state.activeSettings.customRegion;
  if (!r) return;
  els.customRegionX.value = Math.round(r.x);
  els.customRegionY.value = Math.round(r.y);
  els.customRegionW.value = Math.round(r.width);
  els.customRegionH.value = Math.round(r.height);
}

/** Set region to full image dimensions */
export function setRegionToFullImage() {
  const activeFile = getActiveFile();
  if (!activeFile) return;
  const imgW = activeFile.imgElement.naturalWidth;
  const imgH = activeFile.imgElement.naturalHeight;
  state.activeSettings.customRegion = { x: 0, y: 0, width: imgW, height: imgH };
  syncCustomRegionToUI();
  generateEqualDividers();
  syncSettingsFromUI();
  reSliceActiveFile();
}

/** Generate equally-spaced divider lines within the current region */
export function generateEqualDividers() {
  const region = state.activeSettings.customRegion;
  if (!region || region.width <= 0 || region.height <= 0) return;

  const cols = state.activeSettings.customCols || parseInt(els.customCols.value) || 3;
  const rows = state.activeSettings.customRows || parseInt(els.customRows.value) || 3;

  // Generate column dividers (vertical lines)
  const colLines = [];
  for (let i = 1; i < cols; i++) {
    colLines.push(region.x + (region.width * i) / cols);
  }
  
  // Generate row dividers (horizontal lines)
  const rowLines = [];
  for (let i = 1; i < rows; i++) {
    rowLines.push(region.y + (region.height * i) / rows);
  }

  state.activeSettings.customColLines = colLines;
  state.activeSettings.customRowLines = rowLines;
}

function autoDetectRegionBounds(activeFile) {
  const canvas = document.createElement('canvas');
  const w = activeFile.imgElement.naturalWidth;
  const h = activeFile.imgElement.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(activeFile.imgElement, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const alphaThreshold = state.activeSettings.autoTolerance !== undefined ? state.activeSettings.autoTolerance : 5;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: w, height: h };
  return { x: minX, y: minY, width: (maxX - minX + 1), height: (maxY - minY + 1) };
}

/** Auto-detect empty spaces in region and place dividers */
export function autoSnapDividers() {
  let region = state.activeSettings.customRegion;
  const activeFile = getActiveFile();
  if (!activeFile) return;

  if (!region || region.width <= 0 || region.height <= 0) {
    region = autoDetectRegionBounds(activeFile);
    state.activeSettings.customRegion = region;
    syncCustomRegionToUI();
  }

  const rw = Math.round(region.width);
  const rh = Math.round(region.height);
  const rx = Math.round(region.x);
  const ry = Math.round(region.y);

  if (rw <= 0 || rh <= 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(activeFile.imgElement, rx, ry, rw, rh, 0, 0, rw, rh);

  const imgData = ctx.getImageData(0, 0, rw, rh);
  const data = imgData.data;
  const alphaThreshold = state.activeSettings.autoTolerance !== undefined ? state.activeSettings.autoTolerance : 5;

  const emptyCols = new Uint8Array(rw);
  for (let x = 0; x < rw; x++) {
    let empty = 1;
    for (let y = 0; y < rh; y++) {
      if (data[(y * rw + x) * 4 + 3] >= alphaThreshold) {
        empty = 0;
        break;
      }
    }
    emptyCols[x] = empty;
  }

  const emptyRows = new Uint8Array(rh);
  for (let y = 0; y < rh; y++) {
    let empty = 1;
    for (let x = 0; x < rw; x++) {
      if (data[(y * rw + x) * 4 + 3] >= alphaThreshold) {
        empty = 0;
        break;
      }
    }
    emptyRows[y] = empty;
  }

  let firstCol = 0, lastCol = rw - 1;
  while(firstCol <= lastCol && emptyCols[firstCol]) firstCol++;
  while(lastCol >= firstCol && emptyCols[lastCol]) lastCol--;
  let firstRow = 0, lastRow = rh - 1;
  while(firstRow <= lastRow && emptyRows[firstRow]) firstRow++;
  while(lastRow >= firstRow && emptyRows[lastRow]) lastRow--;

  if (firstCol <= lastCol && firstRow <= lastRow) {
    region.x = rx + firstCol;
    region.y = ry + firstRow;
    region.width = lastCol - firstCol + 1;
    region.height = lastRow - firstRow + 1;
    els.customRegionX.value = region.x;
    els.customRegionY.value = region.y;
    els.customRegionW.value = region.width;
    els.customRegionH.value = region.height;
  }

  function getGapCenters(emptyArr, length) {
    const centers = [];
    let inGap = false;
    let start = 0;
    for (let i = 0; i < length; i++) {
      if (emptyArr[i]) {
        if (!inGap) {
          inGap = true;
          start = i;
        }
      } else {
        if (inGap) {
          if (start > 0) {
            centers.push(start + (i - start) / 2);
          }
          inGap = false;
        }
      }
    }
    return centers;
  }

  const colLines = getGapCenters(emptyCols, rw).map(cx => region.x + cx);
  const rowLines = getGapCenters(emptyRows, rh).map(cy => region.y + cy);

  state.activeSettings.customColLines = colLines;
  state.activeSettings.customRowLines = rowLines;
  
  const newCols = Math.max(1, colLines.length + 1);
  const newRows = Math.max(1, rowLines.length + 1);
  state.activeSettings.customCols = newCols;
  state.activeSettings.customRows = newRows;
  els.customCols.value = newCols;
  els.customRows.value = newRows;

  syncSettingsFromUI();
  reSliceActiveFile();
}

/** Snap dividers to closest empty spaces while keeping current grid count */
export function autoSnapDividersKeep() {
  let region = state.activeSettings.customRegion;
  const activeFile = getActiveFile();
  if (!activeFile) return;

  if (!region || region.width <= 0 || region.height <= 0) {
    region = autoDetectRegionBounds(activeFile);
    state.activeSettings.customRegion = region;
    syncCustomRegionToUI();
  }

  const cols = state.activeSettings.customCols || parseInt(els.customCols.value) || 3;
  const rows = state.activeSettings.customRows || parseInt(els.customRows.value) || 3;

  const rw = Math.round(region.width);
  const rh = Math.round(region.height);
  const rx = Math.round(region.x);
  const ry = Math.round(region.y);

  if (rw <= 0 || rh <= 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(activeFile.imgElement, rx, ry, rw, rh, 0, 0, rw, rh);

  const imgData = ctx.getImageData(0, 0, rw, rh);
  const data = imgData.data;
  const alphaThreshold = state.activeSettings.autoTolerance !== undefined ? state.activeSettings.autoTolerance : 5;

  const emptyCols = new Uint8Array(rw);
  for (let x = 0; x < rw; x++) {
    let empty = 1;
    for (let y = 0; y < rh; y++) {
      if (data[(y * rw + x) * 4 + 3] >= alphaThreshold) {
        empty = 0;
        break;
      }
    }
    emptyCols[x] = empty;
  }

  const emptyRows = new Uint8Array(rh);
  for (let y = 0; y < rh; y++) {
    let empty = 1;
    for (let x = 0; x < rw; x++) {
      if (data[(y * rw + x) * 4 + 3] >= alphaThreshold) {
        empty = 0;
        break;
      }
    }
    emptyRows[y] = empty;
  }

  let firstCol = 0, lastCol = rw - 1;
  while(firstCol <= lastCol && emptyCols[firstCol]) firstCol++;
  while(lastCol >= firstCol && emptyCols[lastCol]) lastCol--;
  let firstRow = 0, lastRow = rh - 1;
  while(firstRow <= lastRow && emptyRows[firstRow]) firstRow++;
  while(lastRow >= firstRow && emptyRows[lastRow]) lastRow--;

  if (firstCol <= lastCol && firstRow <= lastRow) {
    region.x = rx + firstCol;
    region.y = ry + firstRow;
    region.width = lastCol - firstCol + 1;
    region.height = lastRow - firstRow + 1;
    els.customRegionX.value = region.x;
    els.customRegionY.value = region.y;
    els.customRegionW.value = region.width;
    els.customRegionH.value = region.height;
  }

  const idealColLines = [];
  for (let i = 1; i < cols; i++) {
    idealColLines.push(region.x + (region.width * i) / cols);
  }
  const idealRowLines = [];
  for (let i = 1; i < rows; i++) {
    idealRowLines.push(region.y + (region.height * i) / rows);
  }

  function getGapCenters(emptyArr, length) {
    const centers = [];
    let inGap = false;
    let start = 0;
    for (let i = 0; i < length; i++) {
      if (emptyArr[i]) {
        if (!inGap) {
          inGap = true;
          start = i;
        }
      } else {
        if (inGap) {
          if (start > 0) {
            centers.push(start + (i - start) / 2);
          }
          inGap = false;
        }
      }
    }
    return centers;
  }

  const colGapCenters = getGapCenters(emptyCols, rw).map(cx => region.x + cx);
  const rowGapCenters = getGapCenters(emptyRows, rh).map(cy => region.y + cy);

  const snapToClosest = (ideal, gaps) => {
    if (gaps.length === 0) return ideal;
    let closest = gaps[0];
    let minDist = Math.abs(ideal - closest);
    for (let i = 1; i < gaps.length; i++) {
      const dist = Math.abs(ideal - gaps[i]);
      if (dist < minDist) {
        minDist = dist;
        closest = gaps[i];
      }
    }
    return closest;
  };

  const finalColLines = idealColLines.map(ideal => snapToClosest(ideal, colGapCenters));
  const finalRowLines = idealRowLines.map(ideal => snapToClosest(ideal, rowGapCenters));

  state.activeSettings.customColLines = finalColLines;
  state.activeSettings.customRowLines = finalRowLines;

  syncSettingsFromUI();
  reSliceActiveFile();
}

/** Toggle region selection mode */
export function toggleRegionSelectMode() {
  if (state.customGrid.isSelectingRegion) {
    exitRegionSelectMode();
  } else {
    state.customGrid.isSelectingRegion = true;
    state.customGrid.regionDragStart = null;
    state.customGrid.regionDragCurrent = null;
    els.btnSelectRegion.classList.add('active');
    els.canvasViewport.classList.add('region-selecting');
  }
}

/** Exit region selection mode */
export function exitRegionSelectMode() {
  state.customGrid.isSelectingRegion = false;
  state.customGrid.regionDragStart = null;
  state.customGrid.regionDragCurrent = null;
  els.btnSelectRegion.classList.remove('active');
  els.canvasViewport.classList.remove('region-selecting');
}

/** Check if coords are near a guideline, returns { type, index } or null */
function findGuidelineAtCoords(coords) {
  if (state.activeSettings.mode !== 'custom') return null;
  const region = state.activeSettings.customRegion;
  if (!region) return null;

  const threshold = Math.max(3, 5 / state.zoom); // Pixel tolerance

  // Check column lines (vertical)
  const colLines = state.activeSettings.customColLines || [];
  for (let i = 0; i < colLines.length; i++) {
    if (Math.abs(coords.x - colLines[i]) < threshold &&
        coords.y >= region.y && coords.y <= region.y + region.height) {
      return { type: 'col', index: i };
    }
  }

  // Check row lines (horizontal)
  const rowLines = state.activeSettings.customRowLines || [];
  for (let i = 0; i < rowLines.length; i++) {
    if (Math.abs(coords.y - rowLines[i]) < threshold &&
        coords.x >= region.x && coords.x <= region.x + region.width) {
      return { type: 'row', index: i };
    }
  }

  return null;
}

/** Check if coords are on a region edge/handle, returns edge string or null */
function findRegionEdgeAtCoords(coords) {
  if (state.activeSettings.mode !== 'custom') return null;
  const region = state.activeSettings.customRegion;
  if (!region) return null;

  const threshold = Math.max(4, 6 / state.zoom);
  const r = region;

  const onLeft = Math.abs(coords.x - r.x) < threshold;
  const onRight = Math.abs(coords.x - (r.x + r.width)) < threshold;
  const onTop = Math.abs(coords.y - r.y) < threshold;
  const onBottom = Math.abs(coords.y - (r.y + r.height)) < threshold;
  const withinX = coords.x >= r.x - threshold && coords.x <= r.x + r.width + threshold;
  const withinY = coords.y >= r.y - threshold && coords.y <= r.y + r.height + threshold;

  if (onTop && onLeft) return 'nw';
  if (onTop && onRight) return 'ne';
  if (onBottom && onLeft) return 'sw';
  if (onBottom && onRight) return 'se';
  if (onTop && withinX) return 'n';
  if (onBottom && withinX) return 's';
  if (onLeft && withinY) return 'w';
  if (onRight && withinY) return 'e';

  // Check if inside region for move
  if (coords.x >= r.x && coords.x <= r.x + r.width &&
      coords.y >= r.y && coords.y <= r.y + r.height) {
    return 'move';
  }

  return null;
}

/** Draw the custom grid overlay on the canvas */
export function drawCustomGridOverlay(canvasW, canvasH) {
  const region = state.activeSettings.customRegion;
  
  // Draw region selection preview if in selection mode and dragging
  if (state.customGrid.isSelectingRegion && 
      state.customGrid.regionDragStart && state.customGrid.regionDragCurrent) {
    const start = state.customGrid.regionDragStart;
    const current = state.customGrid.regionDragCurrent;
    const rx = Math.min(start.x, current.x);
    const ry = Math.min(start.y, current.y);
    const rw = Math.abs(current.x - start.x);
    const rh = Math.abs(current.y - start.y);
    
    // Darken everything outside
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvasW, ry);
    ctx.fillRect(0, ry, rx, rh);
    ctx.fillRect(rx + rw, ry, canvasW - rx - rw, rh);
    ctx.fillRect(0, ry + rh, canvasW, canvasH - ry - rh);
    
    // Selection rectangle
    ctx.strokeStyle = 'rgba(59, 210, 250, 0.9)';
    ctx.lineWidth = Math.max(1, 2 / state.zoom);
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);
    return;
  }

  if (!region || region.width <= 0 || region.height <= 0) return;

  // Darken outside the region
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  // Top
  ctx.fillRect(0, 0, canvasW, region.y);
  // Left
  ctx.fillRect(0, region.y, region.x, region.height);
  // Right
  ctx.fillRect(region.x + region.width, region.y, canvasW - region.x - region.width, region.height);
  // Bottom
  ctx.fillRect(0, region.y + region.height, canvasW, canvasH - region.y - region.height);

  // Region border
  ctx.strokeStyle = 'rgba(59, 210, 250, 0.85)';
  ctx.lineWidth = Math.max(1, 2 / state.zoom);
  ctx.setLineDash([]);
  ctx.strokeRect(region.x, region.y, region.width, region.height);

  // Corner handles
  const handleSize = Math.max(4, 6 / state.zoom);
  ctx.fillStyle = 'rgba(59, 210, 250, 0.95)';
  const corners = [
    [region.x, region.y],
    [region.x + region.width, region.y],
    [region.x, region.y + region.height],
    [region.x + region.width, region.y + region.height]
  ];
  corners.forEach(([cx, cy]) => {
    ctx.fillRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
  });

  // Draw divider lines
  const colLines = state.activeSettings.customColLines || [];
  const rowLines = state.activeSettings.customRowLines || [];
  const hoveredGL = state.customGrid.hoveredGuideline;

  // Vertical dividers (column lines)
  colLines.forEach((x, i) => {
    const isHovered = hoveredGL && hoveredGL.type === 'col' && hoveredGL.index === i;
    const isDragging = state.customGrid.isDraggingGuideline && 
                       state.customGrid.dragGuidelineType === 'col' && 
                       state.customGrid.dragGuidelineIndex === i;
    
    if (isHovered || isDragging) {
      ctx.strokeStyle = 'rgba(255, 200, 50, 0.95)';
      ctx.lineWidth = Math.max(2, 3 / state.zoom);
    } else {
      ctx.strokeStyle = 'rgba(59, 210, 250, 0.5)';
      ctx.lineWidth = Math.max(1, 1.5 / state.zoom);
    }
    ctx.setLineDash([4 / state.zoom, 3 / state.zoom]);
    ctx.beginPath();
    ctx.moveTo(x, region.y);
    ctx.lineTo(x, region.y + region.height);
    ctx.stroke();
  });

  // Horizontal dividers (row lines)
  rowLines.forEach((y, i) => {
    const isHovered = hoveredGL && hoveredGL.type === 'row' && hoveredGL.index === i;
    const isDragging = state.customGrid.isDraggingGuideline && 
                       state.customGrid.dragGuidelineType === 'row' && 
                       state.customGrid.dragGuidelineIndex === i;

    if (isHovered || isDragging) {
      ctx.strokeStyle = 'rgba(255, 200, 50, 0.95)';
      ctx.lineWidth = Math.max(2, 3 / state.zoom);
    } else {
      ctx.strokeStyle = 'rgba(59, 210, 250, 0.5)';
      ctx.lineWidth = Math.max(1, 1.5 / state.zoom);
    }
    ctx.setLineDash([4 / state.zoom, 3 / state.zoom]);
    ctx.beginPath();
    ctx.moveTo(region.x, y);
    ctx.lineTo(region.x + region.width, y);
    ctx.stroke();
  });

  ctx.setLineDash([]);
}

// ----------------------------------------------------
// Custom Grid Mouse Handlers
// ----------------------------------------------------

/** Handle mousedown for custom grid interactions */
export function handleCustomGridMouseDown(e, coords) {
  if (state.activeSettings.mode !== 'custom') return false;

  // Region selection mode
  if (state.customGrid.isSelectingRegion) {
    state.customGrid.regionDragStart = { ...coords };
    state.customGrid.regionDragCurrent = { ...coords };
    return true; // Consume event
  }

  // Check guideline drag
  const gl = findGuidelineAtCoords(coords);
  if (gl) {
    state.customGrid.isDraggingGuideline = true;
    state.customGrid.dragGuidelineType = gl.type;
    state.customGrid.dragGuidelineIndex = gl.index;
    els.canvasViewport.classList.add('guideline-dragging');
    return true;
  }

  // Check region edge/move drag
  const edge = findRegionEdgeAtCoords(coords);
  if (edge) {
    state.customGrid.isDraggingRegion = true;
    state.customGrid.regionDragMode = edge;
    state.customGrid.regionDragOffset = { x: coords.x, y: coords.y };
    if (edge === 'move') {
      els.canvasViewport.classList.add('region-moving');
    }
    return true;
  }

  // Don't intercept — let panning work when clicking outside the region
  return false;
}

/** Handle mousemove for custom grid interactions */
export function handleCustomGridMouseMove(e, coords) {
  if (state.activeSettings.mode !== 'custom') return false;

  // Region selection drag
  if (state.customGrid.isSelectingRegion && state.customGrid.regionDragStart) {
    state.customGrid.regionDragCurrent = { ...coords };
    drawCanvas();
    return true;
  }

  // Guideline dragging
  if (state.customGrid.isDraggingGuideline) {
    const region = state.activeSettings.customRegion;
    if (!region) return true;

    const type = state.customGrid.dragGuidelineType;
    const index = state.customGrid.dragGuidelineIndex;
    const minGap = 2; // Minimum pixels between dividers

    if (type === 'col') {
      const lines = state.activeSettings.customColLines;
      const minX = (index === 0) ? region.x + minGap : lines[index - 1] + minGap;
      const maxX = (index === lines.length - 1) ? region.x + region.width - minGap : lines[index + 1] - minGap;
      lines[index] = Math.max(minX, Math.min(maxX, coords.x));
    } else {
      const lines = state.activeSettings.customRowLines;
      const minY = (index === 0) ? region.y + minGap : lines[index - 1] + minGap;
      const maxY = (index === lines.length - 1) ? region.y + region.height - minGap : lines[index + 1] - minGap;
      lines[index] = Math.max(minY, Math.min(maxY, coords.y));
    }

    syncSettingsFromUI();
    sliceFile(getActiveFile());
    drawCanvas();
    renderPreviews();
    updateExportStats();
    return true;
  }

  // Region edge dragging
  if (state.customGrid.isDraggingRegion) {
    const region = state.activeSettings.customRegion;
    if (!region) return true;
    
    const dx = coords.x - state.customGrid.regionDragOffset.x;
    const dy = coords.y - state.customGrid.regionDragOffset.y;
    const mode = state.customGrid.regionDragMode;
    const activeFile = getActiveFile();
    const imgW = activeFile ? activeFile.imgElement.naturalWidth : 10000;
    const imgH = activeFile ? activeFile.imgElement.naturalHeight : 10000;

    let newX = region.x, newY = region.y, newW = region.width, newH = region.height;

    if (mode === 'move') {
      newX = Math.max(0, Math.min(imgW - newW, region.x + dx));
      newY = Math.max(0, Math.min(imgH - newH, region.y + dy));
      const actualDx = newX - region.x;
      const actualDy = newY - region.y;
      
      if (state.activeSettings.customColLines) {
        state.activeSettings.customColLines = state.activeSettings.customColLines.map(x => x + actualDx);
      }
      if (state.activeSettings.customRowLines) {
        state.activeSettings.customRowLines = state.activeSettings.customRowLines.map(y => y + actualDy);
      }
    } else {
      if (mode.includes('w')) { newX = Math.max(0, region.x + dx); newW = region.width - (newX - region.x); }
      if (mode.includes('e')) { newW = Math.max(10, region.width + dx); }
      if (mode.includes('n')) { newY = Math.max(0, region.y + dy); newH = region.height - (newY - region.y); }
      if (mode.includes('s')) { newH = Math.max(10, region.height + dy); }

      // Clamp to image bounds
      if (newX + newW > imgW) newW = imgW - newX;
      if (newY + newH > imgH) newH = imgH - newY;
      if (newW < 10) newW = 10;
      if (newH < 10) newH = 10;
    }

    state.activeSettings.customRegion = { x: newX, y: newY, width: newW, height: newH };
    state.customGrid.regionDragOffset = { x: coords.x, y: coords.y };
    
    syncCustomRegionToUI();
    syncSettingsFromUI();
    sliceFile(getActiveFile());
    drawCanvas();
    renderPreviews();
    updateExportStats();
    return true;
  }

  // Hover detection for cursor changes
  if (!state.isDragging) {
    const gl = findGuidelineAtCoords(coords);
    const oldHovered = state.customGrid.hoveredGuideline;
    state.customGrid.hoveredGuideline = gl;

    // Remove previous cursor classes
    els.canvasViewport.classList.remove('guideline-hover-col', 'guideline-hover-row',
      'region-edge-n', 'region-edge-s', 'region-edge-e', 'region-edge-w',
      'region-edge-nw', 'region-edge-ne', 'region-edge-sw', 'region-edge-se', 'region-moving');

    if (gl) {
      if (gl.type === 'col') els.canvasViewport.classList.add('guideline-hover-col');
      else els.canvasViewport.classList.add('guideline-hover-row');
      
      if (!oldHovered || oldHovered.type !== gl.type || oldHovered.index !== gl.index) {
        drawCanvas();
      }
      return false; // Don't consume — allow default hover behavior too
    }

    // Check region edge hover
    const edge = findRegionEdgeAtCoords(coords);
    if (edge && edge !== 'move') {
      els.canvasViewport.classList.add(`region-edge-${edge}`);
    }

    if (oldHovered) {
      drawCanvas();
    }
  }

  return false;
}

/** Handle mouseup for custom grid interactions */
export function handleCustomGridMouseUp(e, coords) {
  if (state.activeSettings.mode !== 'custom') return false;

  // Complete region selection
  if (state.customGrid.isSelectingRegion && state.customGrid.regionDragStart) {
    const start = state.customGrid.regionDragStart;
    const end = coords || state.customGrid.regionDragCurrent || start;
    
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);

    if (w > 5 && h > 5) {
      // Clamp to image bounds
      const activeFile = getActiveFile();
      const imgW = activeFile ? activeFile.imgElement.naturalWidth : w;
      const imgH = activeFile ? activeFile.imgElement.naturalHeight : h;
      
      state.activeSettings.customRegion = {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.min(Math.round(w), imgW - Math.max(0, Math.round(x))),
        height: Math.min(Math.round(h), imgH - Math.max(0, Math.round(y)))
      };
      syncCustomRegionToUI();
      generateEqualDividers();
      syncSettingsFromUI();
      reSliceActiveFile();
    }

    exitRegionSelectMode();
    return true;
  }

  // End guideline drag
  if (state.customGrid.isDraggingGuideline) {
    state.customGrid.isDraggingGuideline = false;
    state.customGrid.dragGuidelineType = null;
    state.customGrid.dragGuidelineIndex = null;
    els.canvasViewport.classList.remove('guideline-dragging');
    return true;
  }

  // End region edge drag
  if (state.customGrid.isDraggingRegion) {
    state.customGrid.isDraggingRegion = false;
    state.customGrid.regionDragMode = null;
    state.customGrid.regionDragOffset = null;
    return true;
  }

  return false;
}
