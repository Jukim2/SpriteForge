// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { state, getActiveFile } from '../../app/state.js';
import { els, ctx } from '../../app/dom.js';
import { showToast } from '../../app/ui.js';
import { updateExportStats } from '../exporter.js';
import { syncSettingsFromUI } from './settings.js';
import { reSliceActiveFile } from './process.js';
import { renderPreviews } from './previews.js';
import {
  drawCustomGridOverlay, handleCustomGridMouseDown,
  handleCustomGridMouseMove, handleCustomGridMouseUp
} from './customGrid.js';

export function drawCanvas() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const w = els.canvas.width;
  const h = els.canvas.height;

  ctx.clearRect(0, 0, w, h);

  // 1. Draw original sprite sheet image (or color key filtered version)
  const imgSource = activeFile.processedCanvas || activeFile.imgElement;
  ctx.drawImage(imgSource, 0, 0);

  // 2. Render grids or auto-detected slices bounding boxes
  const slices = activeFile.slices;
  
  slices.forEach(slice => {
    const isHovered = slice.id === state.hoveredSliceId;
    
    if (slice.enabled) {
      if (isHovered) {
        // Highlighting hover active slice (Neon Cyan)
        ctx.strokeStyle = 'rgba(25, 230, 190, 0.95)';
        ctx.fillStyle = 'rgba(25, 230, 190, 0.15)';
        ctx.lineWidth = Math.max(1, 2 / state.zoom);
      } else {
        // Default active slice (Neon Purple)
        ctx.strokeStyle = 'rgba(114, 95, 230, 0.85)';
        ctx.fillStyle = 'rgba(114, 95, 230, 0.05)';
        ctx.lineWidth = Math.max(1, 1.5 / state.zoom);
      }
    } else {
      if (isHovered) {
        // Hovering disabled slice (Red Highlight)
        ctx.strokeStyle = 'rgba(255, 75, 90, 0.85)';
        ctx.fillStyle = 'rgba(255, 75, 90, 0.15)';
        ctx.lineWidth = Math.max(1, 2 / state.zoom);
      } else {
        // Default disabled slice (Semi-transparent dark grey / dashed)
        ctx.strokeStyle = 'rgba(120, 125, 140, 0.3)';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = Math.max(1, 1 / state.zoom);
      }
    }

    // Draw slice rect
    ctx.fillRect(slice.x, slice.y, slice.width, slice.height);
    
    // Support dashed stroke for disabled slices
    if (!slice.enabled) {
      ctx.setLineDash([4 / state.zoom, 4 / state.zoom]);
    } else {
      ctx.setLineDash([]);
    }
    
    ctx.strokeRect(slice.x, slice.y, slice.width, slice.height);
    ctx.setLineDash([]); // Reset line dash

    // Draw little text index in top left of active boxes
    if (slice.enabled && state.zoom >= 1.5) {
      ctx.fillStyle = slice.enabled ? 'rgba(114, 95, 230, 0.9)' : 'rgba(120, 125, 140, 0.5)';
      const fontSize = Math.max(8, Math.min(12, 10 / state.zoom));
      ctx.font = `600 ${fontSize}px sans-serif`;
      
      const label = `${slice.row},${slice.col}`;
      ctx.fillText(label, slice.x + 3, slice.y + fontSize + 2);
    }
  });

  // 3. Custom Grid overlay rendering
  if (state.activeSettings.mode === 'custom') {
    drawCustomGridOverlay(w, h);
  }
}

// ----------------------------------------------------
// Zoom & Pan Actions
// ----------------------------------------------------
function updateTransform() {
  els.canvasContainer.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  // Re-draw canvas bounds because outline lineWidth scales dynamically with zoom
  drawCanvas();
}

function setZoom(level) {
  state.zoom = Math.max(0.05, Math.min(32.0, level));
  updateTransform();
}

function adjustZoom(delta) {
  setZoom(state.zoom + delta);
}

export function zoomToFit() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const vpW = els.canvasViewport.clientWidth;
  const vpH = els.canvasViewport.clientHeight;
  const imgW = activeFile.imgElement.naturalWidth;
  const imgH = activeFile.imgElement.naturalHeight;

  // Calculate scaling factor to fit inside viewport with padding
  const scale = Math.min((vpW - 40) / imgW, (vpH - 40) / imgH);
  state.zoom = Math.max(0.1, Math.min(1.0, scale)); // Fit scale capped at 100% max for sharpness
  
  // Center pan
  state.pan = { x: 0, y: 0 };
  updateTransform();
}

function handleCanvasWheel(e) {
  e.preventDefault();
  const activeFile = getActiveFile();
  if (!activeFile) return;

  // Smooth Zoom logic centering on mouse cursor position
  const rect = els.canvasViewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left - rect.width / 2;
  const mouseY = e.clientY - rect.top - rect.height / 2;

  const oldZoom = state.zoom;
  
  // Scale zoom speed by the actual delta Y to handle varying mouse wheel settings smoothly
  const delta = -e.deltaY;
  const zoomSpeed = 0.0012; // Adjusted for highly controlled, smooth zoom
  let newZoom = oldZoom * Math.exp(delta * zoomSpeed);

  newZoom = Math.max(0.05, Math.min(32.0, newZoom));

  // Adjust pan to zoom on mouse cursor
  state.pan.x = mouseX - (mouseX - state.pan.x) * (newZoom / oldZoom);
  state.pan.y = mouseY - (mouseY - state.pan.y) * (newZoom / oldZoom);
  state.zoom = newZoom;

  updateTransform();
}

function handleCanvasDragStart(e) {
  if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
    // Allow panning with middle click or Shift + left click
    state.isDragging = true;
    state.dragStart = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
    els.canvasViewport.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  if (e.button !== 0) return; // Only drag on left-click

  // Custom Grid interactions take priority
  if (state.activeSettings.mode === 'custom') {
    const coords = getCanvasMouseCoords(e);
    if (handleCustomGridMouseDown(e, coords)) {
      e.preventDefault();
      return; // Custom grid consumed the event
    }
  }

  // If clicking on an active slice, we might trigger a toggle, but dragging should take priority on movement
  state.isDragging = true;
  state.dragStart = {
    x: e.clientX - state.pan.x,
    y: e.clientY - state.pan.y
  };
  els.canvasViewport.style.cursor = 'grabbing';
}

function handleCanvasDragMove(e) {
  // Custom Grid drag interactions
  if (state.activeSettings.mode === 'custom') {
    const coords = getCanvasMouseCoords(e);
    if (handleCustomGridMouseMove(e, coords)) {
      return; // Custom grid consumed the event
    }
  }

  if (!state.isDragging) return;
  state.pan.x = e.clientX - state.dragStart.x;
  state.pan.y = e.clientY - state.dragStart.y;
  updateTransform();
}

function handleCanvasDragEnd(e) {
  // Custom Grid drag end
  if (state.activeSettings.mode === 'custom') {
    const coords = getCanvasMouseCoords(e);
    if (handleCustomGridMouseUp(e, coords)) {
      return; // Custom grid consumed the event
    }
  }

  if (!state.isDragging) return;
  state.isDragging = false;
  els.canvasViewport.style.cursor = 'grab';
}

// ----------------------------------------------------
// Mouse Interactivity (Hover & Click Slices)
// ----------------------------------------------------
function getCanvasMouseCoords(e) {
  const rect = els.canvas.getBoundingClientRect();
  
  // Calculate relative coordinate within 0 to canvas.width/height range
  const x = (e.clientX - rect.left) * (els.canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (els.canvas.height / rect.height);
  
  return { x, y };
}

function findSliceAtCoords(coords) {
  const activeFile = getActiveFile();
  if (!activeFile) return null;

  // Search in reverse order to select top/nested layers if any overlap
  for (let i = activeFile.slices.length - 1; i >= 0; i--) {
    const slice = activeFile.slices[i];
    if (coords.x >= slice.x && coords.x <= slice.x + slice.width &&
        coords.y >= slice.y && coords.y <= slice.y + slice.height) {
      return slice;
    }
  }
  return null;
}

function handleCanvasHover(e) {
  if (state.isDragging) return;
  const coords = getCanvasMouseCoords(e);

  // Custom Grid hover handling
  if (state.activeSettings.mode === 'custom') {
    handleCustomGridMouseMove(e, coords);
  }

  const slice = findSliceAtCoords(coords);
  
  const oldHoveredId = state.hoveredSliceId;
  state.hoveredSliceId = slice ? slice.id : null;

  if (oldHoveredId !== state.hoveredSliceId) {
    drawCanvas();
  }
}

function handleCanvasClick(e) {
  // Guard against click triggering after drag movement
  if (state.isDragging) return;
  
  const coords = getCanvasMouseCoords(e);
  
  if (state.isPickingColor) {
    const color = getPixelColorAtCoords(coords);
    if (color) {
      els.bgColor.value = color;
      state.activeSettings.bgColor = color;
      
      const activeFile = getActiveFile();
      if (activeFile) {
        activeFile.settings.bgColor = color;
      }
      
      state.isPickingColor = false;
      els.canvasViewport.style.cursor = 'grab';
      els.btnPickColor.classList.remove('active');
      
      showToast('Color Selected', `Background color key set to ${color}.`, 'success');
      
      syncSettingsFromUI();
      reSliceActiveFile();
    }
    return;
  }
  
  const slice = findSliceAtCoords(coords);

  if (slice) {
    slice.enabled = !slice.enabled;
    drawCanvas();
    renderPreviews();
    updateExportStats();
  }
}

function getPixelColorAtCoords(coords) {
  const activeFile = getActiveFile();
  if (!activeFile) return null;
  
  const x = Math.floor(coords.x);
  const y = Math.floor(coords.y);
  if (x < 0 || x >= els.canvas.width || y < 0 || y >= els.canvas.height) return null;
  
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 1;
  tempCanvas.height = 1;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(activeFile.imgElement, x, y, 1, 1, 0, 0, 1, 1);
  const pixel = tempCtx.getImageData(0, 0, 1, 1).data;
  
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => {
    const hex = v.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
  
  return rgbToHex(pixel[0], pixel[1], pixel[2]);
}

export function bindCanvasEvents() {
  // Viewport Zoom & Pan
  els.btnZoomIn.addEventListener('click', () => adjustZoom(0.2));
  els.btnZoomOut.addEventListener('click', () => adjustZoom(-0.2));
  els.btnZoomReset.addEventListener('click', () => setZoom(1.0));
  els.btnZoomFit.addEventListener('click', zoomToFit);

  els.canvasViewport.addEventListener('wheel', handleCanvasWheel, { passive: false });
  els.canvasViewport.addEventListener('mousedown', handleCanvasDragStart);
  window.addEventListener('mousemove', handleCanvasDragMove);
  window.addEventListener('mouseup', handleCanvasDragEnd);

  // Hover and Click detection on canvas
  els.canvas.addEventListener('mousemove', handleCanvasHover);
  els.canvas.addEventListener('mouseleave', () => {
    state.hoveredSliceId = null;
    drawCanvas();
  });
  els.canvas.addEventListener('click', handleCanvasClick);
}
