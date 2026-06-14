import JSZip from 'jszip';
import { sliceGrid, sliceAuto, isRegionEmpty, detectGridSize } from './slicer.js';

// Application State
const state = {
  files: [],         // Array of { id, file, name, size, imgElement, slices, settings }
  activeFileId: null,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  hoveredSliceId: null,
  activeSettings: {
    mode: 'grid',       // 'grid' or 'auto'
    gridW: 32,
    gridH: 32,
    autoMinW: 8,
    autoMinH: 8,
    autoTolerance: 5,
    autoRowGap: 12,
    skipEmpty: true,
    namingTemplate: 'sprite_{row}_{col}'
  }
};

// UI Elements
const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  fileList: document.getElementById('file-list'),
  
  modeGrid: document.getElementById('mode-grid'),
  modeAuto: document.getElementById('mode-auto'),
  settingsGrid: document.getElementById('settings-grid'),
  settingsAuto: document.getElementById('settings-auto'),
  
  gridW: document.getElementById('grid-w'),
  gridH: document.getElementById('grid-h'),
  autoMinW: document.getElementById('auto-min-w'),
  autoMinH: document.getElementById('auto-min-h'),
  autoTolerance: document.getElementById('auto-tolerance'),
  autoRowGap: document.getElementById('auto-row-gap'),
  optSkipEmpty: document.getElementById('opt-skip-empty'),
  optNaming: document.getElementById('opt-naming'),
  btnDetectGrid: document.getElementById('btn-detect-grid'),
  btnApplyAll: document.getElementById('btn-apply-all'),
  
  imageInfo: document.getElementById('image-info'),
  zoomLevel: document.getElementById('zoom-level'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomFit: document.getElementById('btn-zoom-fit'),
  btnZoomReset: document.getElementById('btn-zoom-reset'),
  
  canvasViewport: document.getElementById('canvas-viewport'),
  canvasContainer: document.getElementById('canvas-container'),
  canvas: document.getElementById('slicer-canvas'),
  loadingOverlay: document.getElementById('loading-overlay'),
  
  previewCount: document.getElementById('preview-count'),
  btnToggleAllSlices: document.getElementById('btn-toggle-all-slices'),
  previewGrid: document.getElementById('preview-grid'),
  
  exportStats: document.getElementById('export-stats'),
  btnExportActive: document.getElementById('btn-export-active'),
  btnExportAllBatch: document.getElementById('btn-export-all-batch'),
  
  exportProgressContainer: document.getElementById('export-progress-container'),
  progressStatusText: document.getElementById('progress-status-text'),
  progressPercent: document.getElementById('progress-percent'),
  progressFill: document.getElementById('progress-fill'),
  
  themeToggle: document.getElementById('btn-theme-toggle'),
  toastContainer: document.getElementById('toast-container')
};

// Canvas Context
const ctx = els.canvas.getContext('2d');

// Initialize App
function init() {
  bindEvents();
  syncSettingsFromUI();
  updateExportStats();
}

// Bind Event Listeners
function bindEvents() {
  // Theme Toggle
  els.themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light-theme');
    document.body.classList.toggle('dark-theme');
  });

  // Dropzone drag-drop
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', handleFileSelect);
  
  els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  });
  
  els.dropzone.addEventListener('dragleave', () => {
    els.dropzone.classList.remove('dragover');
  });
  
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Mode Select Buttons
  els.modeGrid.addEventListener('click', () => switchMode('grid'));
  els.modeAuto.addEventListener('click', () => switchMode('auto'));

  // Debounce helper to prevent heavy calculations on every keystroke
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  const debouncedReSlice = debounce(() => {
    syncSettingsFromUI();
    reSliceActiveFile();
  }, 350);

  // Configuration inputs changes (debounced for text/numbers, immediate for checkbox)
  const textInputs = [
    els.gridW, els.gridH, els.autoMinW, els.autoMinH, 
    els.autoTolerance, els.autoRowGap, els.optNaming
  ];
  
  textInputs.forEach(input => {
    input.addEventListener('input', debouncedReSlice);
  });

  els.optSkipEmpty.addEventListener('change', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.btnDetectGrid.addEventListener('click', handleDetectGridSize);
  els.btnApplyAll.addEventListener('click', applySettingsToAll);

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

  // Slice Preview Actions
  els.btnToggleAllSlices.addEventListener('click', toggleAllSlices);
  els.btnExportActive.addEventListener('click', exportActiveFileZip);
  els.btnExportAllBatch.addEventListener('click', exportBatchZip);
}

// ----------------------------------------------------
// UI Settings Synchronization
// ----------------------------------------------------
function syncSettingsFromUI() {
  state.activeSettings.gridW = Math.max(1, parseInt(els.gridW.value) || 32);
  state.activeSettings.gridH = Math.max(1, parseInt(els.gridH.value) || 32);
  state.activeSettings.autoMinW = Math.max(1, parseInt(els.autoMinW.value) || 8);
  state.activeSettings.autoMinH = Math.max(1, parseInt(els.autoMinH.value) || 8);
  state.activeSettings.autoTolerance = Math.min(255, Math.max(0, parseInt(els.autoTolerance.value) || 0));
  state.activeSettings.autoRowGap = Math.max(0, parseInt(els.autoRowGap.value) || 0);
  state.activeSettings.skipEmpty = els.optSkipEmpty.checked;
  state.activeSettings.namingTemplate = els.optNaming.value.trim() || 'sprite_{row}_{col}';

  // Update current active file settings copy
  const activeFile = getActiveFile();
  if (activeFile) {
    activeFile.settings = { ...state.activeSettings };
  }
}

function switchMode(mode) {
  state.activeSettings.mode = mode;
  if (mode === 'grid') {
    els.modeGrid.classList.add('active');
    els.modeAuto.classList.remove('active');
    els.settingsGrid.classList.remove('hidden');
    els.settingsAuto.classList.add('hidden');
  } else {
    els.modeGrid.classList.remove('active');
    els.modeAuto.classList.add('active');
    els.settingsGrid.classList.add('hidden');
    els.settingsAuto.classList.remove('hidden');
  }

  // Sync to active file settings copy
  const activeFile = getActiveFile();
  if (activeFile) {
    activeFile.settings.mode = mode;
  }

  reSliceActiveFile();
}

function updateSettingsUI(settings) {
  if (!settings) return;
  
  els.gridW.value = settings.gridW;
  els.gridH.value = settings.gridH;
  els.autoMinW.value = settings.autoMinW;
  els.autoMinH.value = settings.autoMinH;
  els.autoTolerance.value = settings.autoTolerance;
  els.autoRowGap.value = settings.autoRowGap;
  els.optSkipEmpty.checked = settings.skipEmpty;
  els.optNaming.value = settings.namingTemplate;

  state.activeSettings = { ...settings };

  if (settings.mode === 'grid') {
    els.modeGrid.classList.add('active');
    els.modeAuto.classList.remove('active');
    els.settingsGrid.classList.remove('hidden');
    els.settingsAuto.classList.add('hidden');
  } else {
    els.modeGrid.classList.remove('active');
    els.modeAuto.classList.add('active');
    els.settingsGrid.classList.add('hidden');
    els.settingsAuto.classList.remove('hidden');
  }
}

function applySettingsToAll() {
  if (state.files.length <= 1) {
    showToast('Info', 'Add more files to use batch settings copy.', 'info');
    return;
  }

  state.files.forEach(f => {
    f.settings = { ...state.activeSettings };
    // Re-slice each file asynchronously to prevent blocking UI
    setTimeout(() => {
      sliceFile(f);
      if (f.id === state.activeFileId) {
        refreshActiveFileView();
      }
    }, 0);
  });

  showToast('Settings Applied', 'Configuration copied to all files! Press "Export Batch ZIP" at the bottom right to download.', 'success');
  updateExportStats();

  // Highlight the batch export button to guide user
  els.btnExportAllBatch.classList.remove('pulse-highlight');
  void els.btnExportAllBatch.offsetWidth; // trigger reflow
  els.btnExportAllBatch.classList.add('pulse-highlight');
}

function handleDetectGridSize() {
  const activeFile = getActiveFile();
  if (!activeFile) {
    showToast('Error', 'Please load an image first to auto-detect its grid size.', 'error');
    return;
  }

  els.loadingOverlay.classList.remove('hidden');

  // Defer execution slightly to let the loading overlay render
  setTimeout(() => {
    try {
      const size = detectGridSize(activeFile.imgElement, state.activeSettings.autoTolerance);
      
      // Update inputs
      els.gridW.value = size.width;
      els.gridH.value = size.height;
      
      // Update state
      state.activeSettings.gridW = size.width;
      state.activeSettings.gridH = size.height;
      activeFile.settings.gridW = size.width;
      activeFile.settings.gridH = size.height;
      
      showToast('Grid Size Detected', `Automatically set grid to ${size.width}x${size.height}px based on image elements.`, 'success');
      reSliceActiveFile();
    } catch (err) {
      console.error(err);
      showToast('Detection Failed', 'Could not accurately detect grid dimensions.', 'error');
    } finally {
      els.loadingOverlay.classList.add('hidden');
    }
  }, 50);
}

// ----------------------------------------------------
// File Handling
// ----------------------------------------------------
function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    handleFiles(e.target.files);
  }
  els.fileInput.value = ''; // Reset input so same file can be selected again
}

function handleFiles(fileList) {
  let filesLoaded = 0;
  const totalFiles = fileList.length;

  for (let i = 0; i < totalFiles; i++) {
    const file = fileList[i];
    if (!file.type.startsWith('image/')) {
      showToast('Error', `${file.name} is not an image.`, 'error');
      continue;
    }

    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const fileObj = {
          id: fileId,
          file: file,
          name: file.name,
          size: file.size,
          imgElement: img,
          slices: [],
          settings: { ...state.activeSettings }
        };

        state.files.push(fileObj);
        sliceFile(fileObj);
        addFileToSidebar(fileObj);

        // Auto select the first loaded file if none is active
        if (!state.activeFileId) {
          selectFile(fileId);
        }

        filesLoaded++;
        if (filesLoaded === totalFiles) {
          showToast('Loaded Successfully', `Imported ${totalFiles} image(s).`, 'success');
        }
        updateExportStats();
      };
      img.onerror = () => {
        showToast('Error', `Failed to load image: ${file.name}`, 'error');
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }
}

function addFileToSidebar(fileObj) {
  const li = document.createElement('li');
  li.className = 'file-item';
  li.id = fileObj.id;
  li.setAttribute('data-id', fileObj.id);

  const sizeKb = (fileObj.size / 1024).toFixed(1);
  const dimensions = `${fileObj.imgElement.naturalWidth}x${fileObj.imgElement.naturalHeight}`;

  li.innerHTML = `
    <div class="file-info">
      <span class="file-name" title="${fileObj.name}">${fileObj.name}</span>
      <span class="file-meta">${dimensions}px • ${sizeKb} KB</span>
    </div>
    <button class="file-remove" title="Remove image">
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  `;

  // Item click to select
  li.addEventListener('click', (e) => {
    if (e.target.closest('.file-remove')) {
      removeFile(fileObj.id);
    } else {
      selectFile(fileObj.id);
    }
  });

  els.fileList.appendChild(li);
}

function removeFile(fileId) {
  state.files = state.files.filter(f => f.id !== fileId);
  
  const element = document.getElementById(fileId);
  if (element) element.remove();

  if (state.activeFileId === fileId) {
    if (state.files.length > 0) {
      selectFile(state.files[0].id);
    } else {
      state.activeFileId = null;
      clearCanvas();
      renderPreviews();
      els.imageInfo.textContent = 'No image loaded';
    }
  }

  showToast('Removed', 'Image removed from queue.', 'info');
  updateExportStats();
}

function getActiveFile() {
  return state.files.find(f => f.id === state.activeFileId);
}

function selectFile(fileId) {
  state.activeFileId = fileId;

  // Update Sidebar active styling
  document.querySelectorAll('.file-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-id') === fileId);
  });

  const activeFile = getActiveFile();
  if (activeFile) {
    updateSettingsUI(activeFile.settings);
    refreshActiveFileView();
    zoomToFit();
  }
}

// ----------------------------------------------------
// Slicing Logic Execution
// ----------------------------------------------------
function sliceFile(fileObj) {
  const mode = fileObj.settings.mode;
  if (mode === 'grid') {
    fileObj.slices = sliceGrid(
      fileObj.imgElement,
      fileObj.settings.gridW,
      fileObj.settings.gridH,
      fileObj.settings.skipEmpty,
      fileObj.settings.autoTolerance
    );
  } else {
    fileObj.slices = sliceAuto(
      fileObj.imgElement,
      fileObj.settings.autoMinW,
      fileObj.settings.autoMinH,
      fileObj.settings.autoTolerance,
      fileObj.settings.autoRowGap
    );
  }
}

function reSliceActiveFile() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  els.loadingOverlay.classList.remove('hidden');

  // Defer execution slightly to let UI overlay render
  setTimeout(() => {
    sliceFile(activeFile);
    refreshActiveFileView();
    els.loadingOverlay.classList.add('hidden');
  }, 10);
}

function refreshActiveFileView() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  // Setup Canvas Dimensions
  els.canvas.width = activeFile.imgElement.naturalWidth;
  els.canvas.height = activeFile.imgElement.naturalHeight;
  
  els.imageInfo.textContent = `${activeFile.name} (${activeFile.imgElement.naturalWidth}x${activeFile.imgElement.naturalHeight}px)`;

  drawCanvas();
  renderPreviews();
  updateExportStats();
}

// ----------------------------------------------------
// Canvas Visualizer Rendering
// ----------------------------------------------------
function clearCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.canvas.width = 0;
  els.canvas.height = 0;
}

function drawCanvas() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const w = els.canvas.width;
  const h = els.canvas.height;

  ctx.clearRect(0, 0, w, h);

  // 1. Draw original sprite sheet image
  ctx.drawImage(activeFile.imgElement, 0, 0);

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

function zoomToFit() {
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
  if (e.button !== 0) return; // Only drag on left-click
  // If clicking on an active slice, we might trigger a toggle, but dragging should take priority on movement
  state.isDragging = true;
  state.dragStart = {
    x: e.clientX - state.pan.x,
    y: e.clientY - state.pan.y
  };
  els.canvasViewport.style.cursor = 'grabbing';
}

function handleCanvasDragMove(e) {
  if (!state.isDragging) return;
  state.pan.x = e.clientX - state.dragStart.x;
  state.pan.y = e.clientY - state.dragStart.y;
  updateTransform();
}

function handleCanvasDragEnd(e) {
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
  const slice = findSliceAtCoords(coords);

  if (slice) {
    slice.enabled = !slice.enabled;
    drawCanvas();
    renderPreviews();
    updateExportStats();
  }
}

// ----------------------------------------------------
// Preview Generation & List Rendering
// ----------------------------------------------------
function renderPreviews() {
  els.previewGrid.innerHTML = '';
  const activeFile = getActiveFile();
  
  if (!activeFile || activeFile.slices.length === 0) {
    els.previewGrid.innerHTML = `
      <div class="no-sprites-msg">No sprites generated yet. Load an image and adjust slicing configuration.</div>
    `;
    els.previewCount.textContent = '0';
    return;
  }

  const slices = activeFile.slices;
  let enabledCount = 0;

  // Document fragment for better DOM performance
  const fragment = document.createDocumentFragment();

  // Create temporary offscreen canvas to clip individual thumbnails
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');

  slices.forEach(slice => {
    if (slice.enabled) enabledCount++;

    const div = document.createElement('div');
    div.className = `sprite-preview-item ${slice.enabled ? '' : 'disabled'}`;
    div.title = `Row ${slice.row}, Col ${slice.col} (${slice.width}x${slice.height}px)`;
    
    // Clip sprite to inline canvas thumbnail
    tempCanvas.width = slice.width;
    tempCanvas.height = slice.height;
    tempCtx.clearRect(0, 0, slice.width, slice.height);
    tempCtx.drawImage(
      activeFile.imgElement,
      slice.x, slice.y, slice.width, slice.height, // source
      0, 0, slice.width, slice.height               // destination
    );

    const img = document.createElement('img');
    img.src = tempCanvas.toDataURL('image/png');
    div.appendChild(img);

    // Bounding Size info
    const infoSpan = document.createElement('span');
    infoSpan.className = 'sprite-preview-info';
    infoSpan.textContent = `${slice.width}x${slice.height}`;
    div.appendChild(infoSpan);

    // Number Badge
    const badge = document.createElement('span');
    badge.className = 'sprite-preview-badge';
    badge.textContent = slice.id + 1;
    div.appendChild(badge);

    // Toggle click event
    div.addEventListener('click', () => {
      slice.enabled = !slice.enabled;
      div.classList.toggle('disabled', !slice.enabled);
      if (slice.enabled) {
        badge.classList.remove('disabled');
      } else {
        badge.classList.add('disabled');
      }
      drawCanvas();
      updateExportStats();
    });

    fragment.appendChild(div);
  });

  els.previewGrid.appendChild(fragment);
  els.previewCount.textContent = slices.length;

  // Toggle button label
  if (enabledCount === 0) {
    els.btnToggleAllSlices.textContent = 'Select All';
  } else {
    els.btnToggleAllSlices.textContent = 'Select None';
  }
}

function toggleAllSlices() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const anyEnabled = activeFile.slices.some(s => s.enabled);
  activeFile.slices.forEach(s => s.enabled = !anyEnabled);

  drawCanvas();
  renderPreviews();
  updateExportStats();
}

function updateExportStats() {
  const activeFile = getActiveFile();
  
  // Single active export stats
  let activeExportCount = 0;
  if (activeFile) {
    activeExportCount = activeFile.slices.filter(s => s.enabled).length;
    els.btnExportActive.disabled = activeExportCount === 0;
    els.btnExportActive.textContent = `Export Selected (${activeExportCount})`;
  } else {
    els.btnExportActive.disabled = true;
    els.btnExportActive.textContent = 'Export Selected';
  }

  // Batch export stats
  let totalEnabledSlices = 0;
  state.files.forEach(f => {
    totalEnabledSlices += f.slices.filter(s => s.enabled).length;
  });

  els.btnExportAllBatch.disabled = state.files.length === 0 || totalEnabledSlices === 0;
  els.btnExportAllBatch.textContent = `Export Batch ZIP (${state.files.length} Files)`;

  els.exportStats.textContent = `Queue: ${state.files.length} sheet(s) loaded. Current image has ${activeExportCount} slices active. Total batch slices to export: ${totalEnabledSlices}.`;
}

// ----------------------------------------------------
// File Exporting & ZIP Compression (JSZip)
// ----------------------------------------------------
function getFileName(template, row, col, index, sourceName) {
  const cleanName = sourceName.substring(0, sourceName.lastIndexOf('.')) || sourceName;
  return template
    .replace(/{row}/g, String(row).padStart(2, '0'))
    .replace(/{col}/g, String(col).padStart(2, '0'))
    .replace(/{index}/g, String(index).padStart(3, '0'))
    .replace(/{filename}/g, cleanName);
}

// Helper to convert canvas region to blob
function getSliceBlob(imageElement, slice) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = slice.width;
    canvas.height = slice.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      imageElement,
      slice.x, slice.y, slice.width, slice.height,
      0, 0, slice.width, slice.height
    );
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

async function exportActiveFileZip() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Compressing active sheet frames...', 0);

  try {
    const zip = new JSZip();
    const cleanName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
    const template = activeFile.settings.namingTemplate;

    for (let i = 0; i < enabledSlices.length; i++) {
      const slice = enabledSlices[i];
      const blob = await getSliceBlob(activeFile.imgElement, slice);
      const outputName = `${getFileName(template, slice.row, slice.col, slice.id + 1, activeFile.name)}.png`;
      
      zip.file(outputName, blob);

      const percent = Math.round(((i + 1) / enabledSlices.length) * 100);
      updateProgressBar(`Processing frame ${i+1}/${enabledSlices.length}`, percent);
    }

    updateProgressBar('Generating ZIP download...', 100);
    const content = await zip.generateAsync({ type: 'blob' });
    
    // Trigger download
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `${cleanName}_sprites.zip`;
    link.click();

    showToast('Success', `Exported ${enabledSlices.length} sprites for ${activeFile.name}!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('Export Failed', 'An error occurred during ZIP creation.', 'error');
  } finally {
    showProgressBar(false);
  }
}

async function exportBatchZip() {
  if (state.files.length === 0) return;

  const filesToExport = state.files.filter(f => f.slices.some(s => s.enabled));
  if (filesToExport.length === 0) {
    showToast('No active frames', 'Make sure at least one slice is enabled in your queue.', 'info');
    return;
  }

  showProgressBar(true);
  updateProgressBar('Initializing batch zip file...', 0);

  try {
    const zip = new JSZip();
    
    // Count total slices for overall progress bar math
    let totalSlices = 0;
    filesToExport.forEach(f => totalSlices += f.slices.filter(s => s.enabled).length);
    let processedSlicesCount = 0;

    for (let fIdx = 0; fIdx < filesToExport.length; fIdx++) {
      const fileObj = filesToExport[fIdx];
      const enabledSlices = fileObj.slices.filter(s => s.enabled);
      const cleanFolderName = fileObj.name.substring(0, fileObj.name.lastIndexOf('.')) || fileObj.name;
      const folder = zip.folder(cleanFolderName);
      const template = fileObj.settings.namingTemplate;

      for (let sIdx = 0; sIdx < enabledSlices.length; sIdx++) {
        const slice = enabledSlices[sIdx];
        const blob = await getSliceBlob(fileObj.imgElement, slice);
        const outputName = `${getFileName(template, slice.row, slice.col, slice.id + 1, fileObj.name)}.png`;

        folder.file(outputName, blob);
        
        processedSlicesCount++;
        const percent = Math.round((processedSlicesCount / totalSlices) * 100);
        updateProgressBar(`Batch: processing folder "${cleanFolderName}" (${sIdx+1}/${enabledSlices.length})`, percent);
      }
    }

    updateProgressBar('Packaging your multi-sheet ZIP archive...', 100);
    const content = await zip.generateAsync({ type: 'blob' });
    
    // Download zip
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `SpriteForge_Batch_Export.zip`;
    link.click();

    showToast('Batch Success', `Exported ${totalSlices} frames across ${filesToExport.length} sheets!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('Batch Export Failed', 'An error occurred during multi-sheet zip creation.', 'error');
  } finally {
    showProgressBar(false);
  }
}

// ----------------------------------------------------
// UI Progress Overlay & Toast Notifications
// ----------------------------------------------------
function showProgressBar(show) {
  if (show) {
    els.exportProgressContainer.classList.remove('hidden');
    // Disable primary action buttons during export
    els.btnExportActive.disabled = true;
    els.btnExportAllBatch.disabled = true;
  } else {
    els.exportProgressContainer.classList.add('hidden');
    updateExportStats();
  }
}

function updateProgressBar(text, percent) {
  els.progressStatusText.textContent = text;
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
}

function showToast(title, message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-content">
      <span class="toast-title">${title}</span>
      <span class="toast-msg">${message}</span>
    </div>
  `;

  els.toastContainer.appendChild(toast);

  // Auto remove toast
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 4000);
}

// Start the Application
window.addEventListener('DOMContentLoaded', init);
