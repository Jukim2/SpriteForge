import JSZip from 'jszip';
import gifshot from 'gifshot';
import { sliceGrid, sliceAuto, sliceCustomGrid, isRegionEmpty, detectGridSize } from './slicer.js';

// Application State
const state = {
  files: [],         // Array of { id, file, name, size, imgElement, slices, settings, processedCanvas }
  activeFileId: null,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  hoveredSliceId: null,
  isPickingColor: false, // Flag for canvas color sampler
  activeSettings: {
    mode: 'grid',       // 'grid' or 'auto'
    gridW: 32,
    gridH: 32,
    autoMinW: 8,
    autoMinH: 8,
    autoTolerance: 5,
    autoRowGap: 12,
    skipEmpty: true,
    namingTemplate: 'sprite_{row}_{col}',
    enableBgRemoval: false,
    bgRemovalMethod: 'chromakey', // 'chromakey' or 'ai'
    bgRemovalModelSize: 'medium', // 'small' or 'medium'
    bgColor: '#00ff00',
    bgTolerance: 15,
    bgContiguous: true,
    // Custom Grid settings
    customRegion: null,    // { x, y, width, height }
    customCols: 3,
    customRows: 3,
    customColLines: [],    // x-coords of vertical dividers
    customRowLines: [],    // y-coords of horizontal dividers
    // Rematch settings
    rematchEnabled: false,
    rematchMode: 'largest', // 'largest' | 'custom'
    rematchWidth: 64,
    rematchHeight: 64,
    rematchFit: 'contain'  // 'contain' | 'cover' | 'stretch'
  },
  anim: {
    isPlaying: false,
    fps: 10,
    currentFrame: 0,
    timer: null,
    activeTab: 'slices'
  },
  workspaceMode: 'slicer',
  // Custom Grid interaction state
  customGrid: {
    isSelectingRegion: false,
    regionDragStart: null,      // { x, y } canvas coords where drag started
    regionDragCurrent: null,    // { x, y } current drag position
    isDraggingGuideline: false,
    dragGuidelineType: null,    // 'col' or 'row'
    dragGuidelineIndex: null,   // index in colLines/rowLines
    hoveredGuideline: null,     // { type: 'col'|'row', index }
    isDraggingRegion: false,
    regionDragMode: null,       // 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
    regionDragOffset: null      // { x, y }
  },
  video: {
    file: null,
    url: null,
    duration: 0,
    interval: 0.2,
    startRange: 0.0,
    endRange: 0.0,
    enableBgRemoval: false,
    bgRemovalMethod: 'chromakey', // 'chromakey' or 'ai'
    bgRemovalModelSize: 'medium', // 'small' or 'medium'
    bgColor: '#00ff00',
    bgTolerance: 15,
    bgContiguous: true,
    frames: [] // Array of { index, time, canvas, processedCanvas, enabled }
  }
};

// UI Elements
const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  fileList: document.getElementById('file-list'),
  
  modeGrid: document.getElementById('mode-grid'),
  modeAuto: document.getElementById('mode-auto'),
  modeCustom: document.getElementById('mode-custom'),
  settingsGrid: document.getElementById('settings-grid'),
  settingsAuto: document.getElementById('settings-auto'),
  settingsCustom: document.getElementById('settings-custom'),
  
  // Custom Grid UI elements
  btnSelectRegion: document.getElementById('btn-select-region'),
  customRegionX: document.getElementById('custom-region-x'),
  customRegionY: document.getElementById('custom-region-y'),
  customRegionW: document.getElementById('custom-region-w'),
  customRegionH: document.getElementById('custom-region-h'),
  btnRegionFull: document.getElementById('btn-region-full'),
  customCols: document.getElementById('custom-cols'),
  customRows: document.getElementById('custom-rows'),
  btnResetEqual: document.getElementById('btn-reset-equal'),
  
  // Rematch UI elements
  optRematch: document.getElementById('opt-rematch'),
  rematchSettings: document.getElementById('rematch-settings'),
  rematchMode: document.getElementById('rematch-mode'),
  rematchCustomSize: document.getElementById('rematch-custom-size'),
  rematchW: document.getElementById('rematch-w'),
  rematchH: document.getElementById('rematch-h'),
  rematchFit: document.getElementById('rematch-fit'),
  
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
  
  optBgRemoval: document.getElementById('opt-bg-removal'),
  bgRemovalSettings: document.getElementById('bg-removal-settings'),
  optBgRemovalMethod: document.getElementById('opt-bg-removal-method'),
  optBgRemovalModelSize: document.getElementById('opt-bg-removal-model-size'),
  chromakeySettingsGroup: document.getElementById('chromakey-settings-group'),
  aiSettingsGroup: document.getElementById('ai-settings-group'),
  bgColor: document.getElementById('bg-color'),
  btnPickColor: document.getElementById('btn-pick-color'),
  btnAutoDetectBg: document.getElementById('btn-auto-detect-bg'),
  bgTolerance: document.getElementById('bg-tolerance'),
  labelBgTolerance: document.getElementById('label-bg-tolerance'),
  optBgContiguous: document.getElementById('opt-bg-contiguous'),
  
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
  toastContainer: document.getElementById('toast-container'),
  
  tabSlices: document.getElementById('tab-slices'),
  tabAnimation: document.getElementById('tab-animation'),
  viewSlices: document.getElementById('view-slices'),
  viewAnimation: document.getElementById('view-animation'),
  animCanvas: document.getElementById('anim-canvas'),
  animNoFramesMsg: document.getElementById('anim-no-frames-msg'),
  btnAnimPlay: document.getElementById('btn-anim-play'),
  animFrameIdx: document.getElementById('anim-frame-idx'),
  animFrameTotal: document.getElementById('anim-frame-total'),
  animFps: document.getElementById('anim-fps'),
  labelAnimFps: document.getElementById('label-anim-fps'),
  btnExportGif: document.getElementById('btn-export-gif'),
  btnExportWebm: document.getElementById('btn-export-webm'),

  wsBtnSlicer: document.getElementById('ws-btn-slicer'),
  wsBtnVideo: document.getElementById('ws-btn-video'),
  slicerSidebarContent: document.getElementById('slicer-sidebar-content'),
  videoSidebarContent: document.getElementById('video-sidebar-content'),
  slicerViewportContent: document.getElementById('slicer-viewport-content'),
  videoViewportContent: document.getElementById('video-viewport-content'),
  
  videoDropzone: document.getElementById('video-dropzone'),
  videoFileInput: document.getElementById('video-file-input'),
  videoFileInfoContainer: document.getElementById('video-file-info-container'),
  videoCurrentName: document.getElementById('video-current-name'),
  videoCurrentMeta: document.getElementById('video-current-meta'),
  videoIntervalInput: document.getElementById('video-interval-input'),
  videoOptAllFrames: document.getElementById('video-opt-all-frames'),
  videoRangeStart: document.getElementById('video-range-start'),
  videoRangeEnd: document.getElementById('video-range-end'),
  btnVideoUseFull: document.getElementById('btn-video-use-full'),
  btnVideoExtract: document.getElementById('btn-video-extract'),
  
  wsVideoPlayer: document.getElementById('ws-video-player'),
  videoFramesGrid: document.getElementById('video-frames-grid'),
  videoGridPlaceholder: document.getElementById('video-grid-placeholder'),
  videoToolbarInfo: document.getElementById('video-toolbar-info'),
  videoTimeDisplay: document.getElementById('video-time-display'),
  videoOptBgRemoval: document.getElementById('video-opt-bg-removal'),
  videoBgRemovalSettings: document.getElementById('video-bg-removal-settings'),
  videoOptBgRemovalMethod: document.getElementById('video-opt-bg-removal-method'),
  videoOptBgRemovalModelSize: document.getElementById('video-opt-bg-removal-model-size'),
  videoChromakeySettingsGroup: document.getElementById('video-chromakey-settings-group'),
  videoAiSettingsGroup: document.getElementById('video-ai-settings-group'),
  videoBgColor: document.getElementById('video-bg-color'),
  videoBtnPickColor: document.getElementById('video-btn-pick-color'),
  videoBtnAutoDetectBg: document.getElementById('video-btn-auto-detect-bg'),
  videoBgTolerance: document.getElementById('video-bg-tolerance'),
  videoLabelBgTolerance: document.getElementById('video-label-bg-tolerance'),
  videoOptBgContiguous: document.getElementById('video-opt-bg-contiguous'),
  videoLoadingOverlay: document.getElementById('video-loading-overlay')
};

// Canvas Context
const ctx = els.canvas.getContext('2d');

// Initialize App
function init() {
  bindEvents();
  syncSettingsFromUI();
  updateExportStats();
  switchWorkspaceMode('slicer'); // Initialize UI layout states
}

function toggleBgRemovalSettingsUI() {
  const method = els.optBgRemovalMethod.value;
  if (method === 'ai') {
    els.chromakeySettingsGroup.classList.add('hidden');
    els.aiSettingsGroup.classList.remove('hidden');
  } else {
    els.chromakeySettingsGroup.classList.remove('hidden');
    els.aiSettingsGroup.classList.add('hidden');
  }
}

function toggleVideoBgRemovalSettingsUI() {
  const method = els.videoOptBgRemovalMethod.value;
  if (method === 'ai') {
    els.videoChromakeySettingsGroup.classList.add('hidden');
    els.videoAiSettingsGroup.classList.remove('hidden');
  } else {
    els.videoChromakeySettingsGroup.classList.remove('hidden');
    els.videoAiSettingsGroup.classList.add('hidden');
  }
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
  els.modeCustom.addEventListener('click', () => switchMode('custom'));

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

  // Custom Grid event bindings
  els.btnSelectRegion.addEventListener('click', toggleRegionSelectMode);
  
  const debouncedCustomRegionUpdate = debounce(() => {
    syncCustomRegionFromUI();
    generateEqualDividers();
    syncSettingsFromUI();
    reSliceActiveFile();
  }, 350);
  
  [els.customRegionX, els.customRegionY, els.customRegionW, els.customRegionH].forEach(input => {
    input.addEventListener('input', debouncedCustomRegionUpdate);
  });
  
  const debouncedCustomGridUpdate = debounce(() => {
    syncSettingsFromUI();
    generateEqualDividers();
    syncSettingsFromUI();
    reSliceActiveFile();
  }, 350);
  
  [els.customCols, els.customRows].forEach(input => {
    input.addEventListener('input', debouncedCustomGridUpdate);
  });
  
  els.btnRegionFull.addEventListener('click', setRegionToFullImage);
  els.btnResetEqual.addEventListener('click', () => {
    generateEqualDividers();
    syncSettingsFromUI();
    reSliceActiveFile();
  });
  
  // Rematch event bindings
  els.optRematch.addEventListener('change', (e) => {
    if (e.target.checked) {
      els.rematchSettings.classList.remove('hidden');
    } else {
      els.rematchSettings.classList.add('hidden');
    }
    syncSettingsFromUI();
  });
  
  els.rematchMode.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      els.rematchCustomSize.classList.remove('hidden');
    } else {
      els.rematchCustomSize.classList.add('hidden');
    }
    syncSettingsFromUI();
  });
  
  [els.rematchW, els.rematchH].forEach(input => {
    input.addEventListener('input', () => syncSettingsFromUI());
  });
  
  els.rematchFit.addEventListener('change', () => syncSettingsFromUI());

  els.optSkipEmpty.addEventListener('change', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.optBgRemoval.addEventListener('change', (e) => {
    if (e.target.checked) {
      els.bgRemovalSettings.classList.remove('hidden');
    } else {
      els.bgRemovalSettings.classList.add('hidden');
    }
    toggleBgRemovalSettingsUI();
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.optBgRemovalMethod.addEventListener('change', () => {
    toggleBgRemovalSettingsUI();
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.optBgRemovalModelSize.addEventListener('change', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.bgColor.addEventListener('input', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.bgTolerance.addEventListener('input', (e) => {
    els.labelBgTolerance.textContent = `Tolerance (${e.target.value})`;
  });

  els.bgTolerance.addEventListener('change', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.optBgContiguous.addEventListener('change', () => {
    syncSettingsFromUI();
    reSliceActiveFile();
  });

  els.btnPickColor.addEventListener('click', (e) => {
    e.stopPropagation();
    state.isPickingColor = !state.isPickingColor;
    if (state.isPickingColor) {
      els.canvasViewport.style.cursor = 'crosshair';
      els.btnPickColor.classList.add('active');
      showToast('Color Sampler Active', 'Click anywhere on the canvas to select the background color.', 'info');
    } else {
      els.canvasViewport.style.cursor = 'grab';
      els.btnPickColor.classList.remove('active');
    }
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

  // Preview Tabs Event
  els.tabSlices.addEventListener('click', () => switchPreviewTab('slices'));
  els.tabAnimation.addEventListener('click', () => switchPreviewTab('animation'));

  // Animation Playback Events
  els.btnAnimPlay.addEventListener('click', toggleAnimPlayback);
  els.animFps.addEventListener('input', handleAnimFpsChange);
  els.btnExportGif.addEventListener('click', exportAnimationGif);
  els.btnExportWebm.addEventListener('click', exportAnimationWebm);

  // Workspace Switching Events
  els.wsBtnSlicer.addEventListener('click', () => switchWorkspaceMode('slicer'));
  els.wsBtnVideo.addEventListener('click', () => switchWorkspaceMode('video'));

  // Video Dropzone Events
  els.videoDropzone.addEventListener('click', () => els.videoFileInput.click());
  els.videoFileInput.addEventListener('change', handleVideoFileSelect);

  els.videoDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.videoDropzone.classList.add('dragover');
  });

  els.videoDropzone.addEventListener('dragleave', () => {
    els.videoDropzone.classList.remove('dragover');
  });

  els.videoDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.videoDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('video/')) {
        loadVideoFile(file);
      } else {
        showToast('Error', 'Please upload a valid video file.', 'error');
      }
    }
  });

  // Video Extraction Settings Controls
  els.videoIntervalInput.addEventListener('input', () => {
    state.video.interval = Math.max(0.01, parseFloat(els.videoIntervalInput.value) || 0.2);
  });

  els.videoOptAllFrames.addEventListener('change', (e) => {
    els.videoIntervalInput.disabled = e.target.checked;
  });

  els.videoRangeStart.addEventListener('input', () => {
    let startVal = parseFloat(els.videoRangeStart.value) || 0;
    startVal = Math.max(0, Math.min(state.video.duration, startVal));
    state.video.startRange = startVal;
  });

  els.videoRangeEnd.addEventListener('input', () => {
    let endVal = parseFloat(els.videoRangeEnd.value) || 0;
    endVal = Math.max(0, Math.min(state.video.duration, endVal));
    state.video.endRange = endVal;
  });

  els.btnVideoUseFull.addEventListener('click', () => {
    if (state.video.duration > 0) {
      state.video.startRange = 0.0;
      state.video.endRange = state.video.duration;
      els.videoRangeStart.value = "0.0";
      els.videoRangeEnd.value = state.video.duration.toFixed(1);
      showToast('Range Reset', 'Selected entire video duration.', 'info');
    }
  });

  els.videoOptBgRemoval.addEventListener('change', async (e) => {
    state.video.enableBgRemoval = e.target.checked;
    if (e.target.checked) {
      els.videoBgRemovalSettings.classList.remove('hidden');
    } else {
      els.videoBgRemovalSettings.classList.add('hidden');
    }
    toggleVideoBgRemovalSettingsUI();
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoOptBgRemovalMethod.addEventListener('change', async (e) => {
    state.video.bgRemovalMethod = e.target.value;
    toggleVideoBgRemovalSettingsUI();
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoOptBgRemovalModelSize.addEventListener('change', async (e) => {
    state.video.bgRemovalModelSize = e.target.value;
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoBgColor.addEventListener('input', async (e) => {
    state.video.bgColor = e.target.value;
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoBgTolerance.addEventListener('input', (e) => {
    els.videoLabelBgTolerance.textContent = `Tolerance (${e.target.value})`;
  });

  els.videoBgTolerance.addEventListener('change', async (e) => {
    state.video.bgTolerance = parseInt(e.target.value) || 15;
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoOptBgContiguous.addEventListener('change', async (e) => {
    state.video.bgContiguous = e.target.checked;
    await applyVideoBgRemoval();
    renderVideoFramesGrid();
    updateAnimationPlayer();
  });

  els.videoBtnPickColor.addEventListener('click', (e) => {
    e.stopPropagation();
    state.isPickingColor = !state.isPickingColor;
    const viewport = document.querySelector('#video-viewport-content .canvas-viewport');
    if (state.isPickingColor) {
      viewport.style.cursor = 'crosshair';
      els.videoBtnPickColor.classList.add('active');
      showToast('Color Sampler Active', 'Click anywhere inside a frame image to select the background color.', 'info');
    } else {
      viewport.style.cursor = 'default';
      els.videoBtnPickColor.classList.remove('active');
    }
  });

  els.btnVideoExtract.addEventListener('click', extractVideoRangeFrames);

  els.wsVideoPlayer.addEventListener('timeupdate', () => {
    updateVideoTimeDisplay();
  });

  // Slicer Auto-Detect Background Color
  els.btnAutoDetectBg.addEventListener('click', (e) => {
    e.stopPropagation();
    autoDetectSlicerBgColor();
  });

  // Video Auto-Detect Background Color
  els.videoBtnAutoDetectBg.addEventListener('click', (e) => {
    e.stopPropagation();
    autoDetectVideoBgColor();
  });

  // Slicer Color Swatches
  document.querySelectorAll('.swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const color = swatch.getAttribute('data-color');
      els.bgColor.value = color;
      state.activeSettings.bgColor = color;
      
      const activeFile = getActiveFile();
      if (activeFile) {
        activeFile.settings.bgColor = color;
      }
      
      showToast('Swatch Selected', `Background color key set to ${color}.`, 'success');
      syncSettingsFromUI();
      reSliceActiveFile();
    });
  });

  // Video Color Swatches
  document.querySelectorAll('.video-swatch').forEach(swatch => {
    swatch.addEventListener('click', async () => {
      const color = swatch.getAttribute('data-color');
      els.videoBgColor.value = color;
      state.video.bgColor = color;
      
      showToast('Swatch Selected', `Video background color key set to ${color}.`, 'success');
      await applyVideoBgRemoval();
      renderVideoFramesGrid();
      updateAnimationPlayer();
    });
  });
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
  state.activeSettings.enableBgRemoval = els.optBgRemoval.checked;
  state.activeSettings.bgRemovalMethod = els.optBgRemovalMethod.value;
  state.activeSettings.bgRemovalModelSize = els.optBgRemovalModelSize.value;
  state.activeSettings.bgColor = els.bgColor.value;
  state.activeSettings.bgTolerance = parseInt(els.bgTolerance.value) || 15;
  state.activeSettings.bgContiguous = els.optBgContiguous.checked;

  // Custom Grid settings
  state.activeSettings.customCols = Math.max(1, Math.min(50, parseInt(els.customCols.value) || 3));
  state.activeSettings.customRows = Math.max(1, Math.min(50, parseInt(els.customRows.value) || 3));
  // customRegion, customColLines, customRowLines are synced directly via interaction handlers

  // Rematch settings
  state.activeSettings.rematchEnabled = els.optRematch.checked;
  state.activeSettings.rematchMode = els.rematchMode.value;
  state.activeSettings.rematchWidth = Math.max(1, parseInt(els.rematchW.value) || 64);
  state.activeSettings.rematchHeight = Math.max(1, parseInt(els.rematchH.value) || 64);
  state.activeSettings.rematchFit = els.rematchFit.value;

  // Update current active file settings copy
  const activeFile = getActiveFile();
  if (activeFile) {
    activeFile.settings = { ...state.activeSettings };
    // Preserve array/object references for custom grid
    if (state.activeSettings.customRegion) {
      activeFile.settings.customRegion = { ...state.activeSettings.customRegion };
    }
    activeFile.settings.customColLines = [...state.activeSettings.customColLines];
    activeFile.settings.customRowLines = [...state.activeSettings.customRowLines];
  }
}

// ----------------------------------------------------
// Workspace Switcher & Video Operations
// ----------------------------------------------------
function switchWorkspaceMode(mode) {
  state.workspaceMode = mode;
  state.isPickingColor = false;
  els.canvasViewport.style.cursor = 'grab';
  els.btnPickColor.classList.remove('active');
  const videoViewport = document.querySelector('#video-viewport-content .canvas-viewport');
  if (videoViewport) videoViewport.style.cursor = 'default';
  if (els.videoBtnPickColor) els.videoBtnPickColor.classList.remove('active');

  if (mode === 'slicer') {
    els.wsBtnSlicer.classList.add('active');
    els.wsBtnVideo.classList.remove('active');

    els.slicerSidebarContent.classList.remove('hidden');
    els.videoSidebarContent.classList.add('hidden');
    els.slicerViewportContent.classList.remove('hidden');
    els.videoViewportContent.classList.add('hidden');

    // Show tab-slices header
    els.tabSlices.style.display = 'block';

    // Pause video if playing
    els.wsVideoPlayer.pause();
    
    // Switch preview tab to activeTab or default to slices
    switchPreviewTab(state.anim.activeTab || 'slices');

    // Refresh canvas and previews
    drawCanvas();
    renderPreviews();

    // Show standard export footer (only if slices tab is active)
    if (state.anim.activeTab === 'slices') {
      document.querySelector('.export-footer').classList.remove('hidden');
    }
  } else {
    els.wsBtnSlicer.classList.remove('active');
    els.wsBtnVideo.classList.add('active');

    els.slicerSidebarContent.classList.add('hidden');
    els.videoSidebarContent.classList.remove('hidden');
    els.slicerViewportContent.classList.add('hidden');
    els.videoViewportContent.classList.remove('hidden');

    // Hide tab-slices header entirely in Video Mode
    els.tabSlices.style.display = 'none';

    // Switch right panel to animation tab
    switchPreviewTab('animation');

    // Hide standard export footer
    document.querySelector('.export-footer').classList.add('hidden');
    
    // Stop slice preview playback loop if active
    stopAnimPlayback();

    // Update animation player for video mode
    updateAnimationPlayer();
  }
}

function handleVideoFileSelect(e) {
  if (e.target.files.length > 0) {
    loadVideoFile(e.target.files[0]);
  }
  els.videoFileInput.value = ''; // Reset input
}

function loadVideoFile(file) {
  if (state.video.url) {
    URL.revokeObjectURL(state.video.url);
  }

  showProgressBar(true);
  updateProgressBar('Loading video metadata...', 30);

  // Clear previous frames
  state.video.frames = [];
  if (els.videoFramesGrid) {
    els.videoFramesGrid.innerHTML = `
      <div id="video-grid-placeholder" class="no-sprites-msg" style="grid-column: 1 / -1; padding: 80px 20px; border: 1px dashed var(--border-color); border-radius: 8px; text-align: center; width: 100%;">
        No video frames loaded. Select a video, set range/interval in the sidebar, and click "Extract Video Frames".
      </div>
    `;
  }

  const playerContainer = document.getElementById('video-player-container');
  if (playerContainer) playerContainer.style.display = 'none';

  if (els.videoOptAllFrames) {
    els.videoOptAllFrames.checked = false;
    els.videoOptAllFrames.disabled = true;
    els.videoIntervalInput.disabled = false;
  }

  try {
    state.video.file = file;
    state.video.url = URL.createObjectURL(file);
    els.wsVideoPlayer.src = state.video.url;
    els.wsVideoPlayer.load();

    els.wsVideoPlayer.onloadedmetadata = () => {
      const duration = els.wsVideoPlayer.duration;
      state.video.duration = duration;
      state.video.startRange = 0.0;
      state.video.endRange = duration;

      // Update inputs
      els.videoRangeStart.min = "0.0";
      els.videoRangeStart.max = duration.toFixed(1);
      els.videoRangeStart.value = "0.0";

      els.videoRangeEnd.min = "0.0";
      els.videoRangeEnd.max = duration.toFixed(1);
      els.videoRangeEnd.value = duration.toFixed(1);

      // Info display
      els.videoCurrentName.textContent = file.name;
      els.videoCurrentName.title = file.name;
      els.videoCurrentMeta.textContent = `${els.wsVideoPlayer.videoWidth}x${els.wsVideoPlayer.videoHeight}px • ${duration.toFixed(1)}s`;
      els.videoFileInfoContainer.classList.remove('hidden');
      els.videoToolbarInfo.textContent = `${file.name} (${els.wsVideoPlayer.videoWidth}x${els.wsVideoPlayer.videoHeight}px)`;

      els.btnVideoExtract.disabled = false;
      if (els.videoOptAllFrames) {
        els.videoOptAllFrames.disabled = false;
      }
      if (playerContainer) {
        playerContainer.style.display = 'flex';
      }
      
      updateVideoTimeDisplay();
      showProgressBar(false);
      showToast('Video Loaded', `Ready to extract from ${file.name}.`, 'success');
    };

    els.wsVideoPlayer.onerror = () => {
      showProgressBar(false);
      showToast('Load Error', 'Failed to load video file. Make sure it is a supported video format.', 'error');
    };
  } catch (err) {
    console.error(err);
    showProgressBar(false);
    showToast('Error', 'Failed to read video file.', 'error');
  }
}

function updateVideoTimeDisplay() {
  const formatTime = (seconds) => {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms}`;
  };

  const current = els.wsVideoPlayer.currentTime || 0;
  const total = state.video.duration || 0;
  els.videoTimeDisplay.textContent = `${formatTime(current)} / ${formatTime(total)}`;
}

async function extractVideoRangeFrames() {
  if (!state.video.file || !state.video.url) {
    showToast('Error', 'Please load a video file first.', 'error');
    return;
  }

  const start = parseFloat(els.videoRangeStart.value) || 0.0;
  const end = parseFloat(els.videoRangeEnd.value) || state.video.duration;
  let interval = parseFloat(els.videoIntervalInput.value) || 0.2;
  if (els.videoOptAllFrames && els.videoOptAllFrames.checked) {
    interval = 0.0333;
  }

  if (start >= end) {
    showToast('Range Error', 'Start time must be less than End time.', 'error');
    return;
  }

  showProgressBar(true);
  updateProgressBar('Initializing frames extraction...', 0);
  if (els.videoLoadingOverlay) {
    els.videoLoadingOverlay.classList.remove('hidden');
    const loadingText = document.getElementById('video-loading-text');
    if (loadingText) loadingText.textContent = 'Initializing frames extraction...';
  }

  const frameTimes = [];
  for (let t = start; t <= end; t += interval) {
    if (t <= state.video.duration + 0.0001) {
      frameTimes.push(t);
    }
  }

  if (frameTimes.length === 0) {
    showProgressBar(false);
    if (els.videoLoadingOverlay) els.videoLoadingOverlay.classList.add('hidden');
    showToast('Extraction Error', 'No frames found in the specified range.', 'error');
    return;
  }

  // Clear previous frames
  state.video.frames = [];

  const extractVideo = document.createElement('video');
  extractVideo.src = state.video.url;
  extractVideo.muted = true;
  extractVideo.playsInline = true;
  extractVideo.preload = 'auto';

  try {
    await new Promise((resolve, reject) => {
      extractVideo.addEventListener('loadedmetadata', resolve, { once: true });
      extractVideo.addEventListener('error', () => reject(new Error('Extraction preload failed.')), { once: true });
    });

    for (let i = 0; i < frameTimes.length; i++) {
      const targetTime = frameTimes[i];
      const percent = Math.round((i / frameTimes.length) * 100);
      updateProgressBar(`Extracting frame ${i + 1}/${frameTimes.length} (${percent}%)`, percent);
      const loadingText = document.getElementById('video-loading-text');
      if (loadingText) {
        loadingText.textContent = `Extracting frame ${i + 1}/${frameTimes.length} (${percent}%)`;
      }

      extractVideo.currentTime = targetTime;

      // Wait for seeked
      await new Promise((resolve) => {
        const onSeeked = () => {
          extractVideo.removeEventListener('seeked', onSeeked);
          resolve();
        };
        extractVideo.addEventListener('seeked', onSeeked);
      });

      // Capture frame to canvas
      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = extractVideo.videoWidth;
      frameCanvas.height = extractVideo.videoHeight;
      const frameCtx = frameCanvas.getContext('2d');
      frameCtx.drawImage(extractVideo, 0, 0, frameCanvas.width, frameCanvas.height);

      // Create a processed canvas for background removal
      const processedCanvas = document.createElement('canvas');
      processedCanvas.width = frameCanvas.width;
      processedCanvas.height = frameCanvas.height;
      const processedCtx = processedCanvas.getContext('2d');
      processedCtx.drawImage(frameCanvas, 0, 0);

      state.video.frames.push({
        index: i,
        time: targetTime,
        canvas: frameCanvas,
        processedCanvas: processedCanvas,
        enabled: true
      });
    }

    // Apply background removal if enabled
    await applyVideoBgRemoval();

    // Render grid
    renderVideoFramesGrid();

    // Reset and initialize animation preview
    state.anim.currentFrame = 0;
    updateAnimationPlayer();

    showToast('Success', `Extracted ${frameTimes.length} frames successfully.`, 'success');
  } catch (err) {
    console.error(err);
    showToast('Extraction Failed', err.message || 'Frame extraction failed.', 'error');
  } finally {
    showProgressBar(false);
    if (els.videoLoadingOverlay) {
      els.videoLoadingOverlay.classList.add('hidden');
    }
  }
}

function rgbToYuv(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.169 * r - 0.331 * g + 0.500 * b + 128;
  const v = 0.500 * r - 0.419 * g - 0.081 * b + 128;
  return { y, u, v };
}

function detectCornerColor(canvas) {
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

function getContiguousBgMask(width, height, data, targetYuv, wY, wU, wV, maxThreshold) {
  const mask = new Uint8Array(width * height); // 1 = background, 0 = foreground
  const queue = [];
  
  function checkAndPush(x, y) {
    const idx = y * width + x;
    if (mask[idx] === 0) {
      const pIdx = idx * 4;
      const r = data[pIdx];
      const g = data[pIdx + 1];
      const b = data[pIdx + 2];
      const a = data[pIdx + 3];
      
      // If it's already fully transparent, it's background
      if (a === 0) {
        mask[idx] = 1;
        queue.push(idx);
        return;
      }
      
      const pixelYuv = rgbToYuv(r, g, b);
      const dist = Math.sqrt(
        wY * ((pixelYuv.y - targetYuv.y) ** 2) +
        wU * ((pixelYuv.u - targetYuv.u) ** 2) +
        wV * ((pixelYuv.v - targetYuv.v) ** 2)
      );
      
      if (dist < maxThreshold) {
        mask[idx] = 1;
        queue.push(idx);
      }
    }
  }
  
  // Seed the entire border/perimeter of the image
  for (let x = 0; x < width; x++) {
    checkAndPush(x, 0);
    checkAndPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    checkAndPush(0, y);
    checkAndPush(width - 1, y);
  }
  
  // DFS using stack array (pop is fast)
  while (queue.length > 0) {
    const idx = queue.pop();
    const x = idx % width;
    const y = Math.floor(idx / width);
    
    // Check 4-connected neighbors
    if (x > 0) checkAndPush(x - 1, y);
    if (x < width - 1) checkAndPush(x + 1, y);
    if (y > 0) checkAndPush(x, y - 1);
    if (y < height - 1) checkAndPush(x, y + 1);
  }
  
  return mask;
}

function decontaminateEdges(width, height, data) {
  const temp = new Uint8ClampedArray(data);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      
      // If the pixel is semi-transparent, replace its color with the nearest fully opaque pixel
      if (a > 0 && a < 255) {
        let found = false;
        let bestR = 0, bestG = 0, bestB = 0;
        let minDist = Infinity;
        
        // Search a 3x3 neighborhood
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
  
  // Copy back
  for (let i = 0; i < data.length; i++) {
    data[i] = temp[i];
  }
}

function autoDetectSlicerBgColor() {
  const activeFile = getActiveFile();
  if (!activeFile || !activeFile.imgElement) {
    showToast('No Image Loaded', 'Please load a spritesheet image first.', 'warning');
    return;
  }

  const img = activeFile.imgElement;
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = img.naturalWidth;
  tempCanvas.height = img.naturalHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(img, 0, 0);

  const color = detectCornerColor(tempCanvas);
  
  els.bgColor.value = color;
  state.activeSettings.bgColor = color;
  activeFile.settings.bgColor = color;

  showToast('Auto-Detected Color', `Background color key set to ${color}.`, 'success');

  syncSettingsFromUI();
  reSliceActiveFile();
}

async function autoDetectVideoBgColor() {
  if (state.video.frames && state.video.frames.length > 0) {
    const frame = state.video.frames[0];
    const color = detectCornerColor(frame.canvas);
    await setVideoBgColor(color);
    showToast('Auto-Detected Color', `Background color key set to ${color} (from first frame).`, 'success');
  } else if (els.wsVideoPlayer && els.wsVideoPlayer.readyState >= 2) {
    const video = els.wsVideoPlayer;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    const color = detectCornerColor(tempCanvas);
    await setVideoBgColor(color);
    showToast('Auto-Detected Color', `Background color key set to ${color} (from video player).`, 'success');
  } else {
    showToast('No Video Loaded', 'Please load a video first to auto-detect background color.', 'warning');
  }
}

async function setVideoBgColor(color) {
  state.video.bgColor = color;
  els.videoBgColor.value = color;
  await applyVideoBgRemoval();
  renderVideoFramesGrid();
  updateAnimationPlayer();
}

async function applyVideoBgRemoval() {
  if (state.video.frames.length === 0) return;

  const enable = state.video.enableBgRemoval;
  const method = state.video.bgRemovalMethod || 'chromakey';

  if (!enable) {
    state.video.frames.forEach(frame => {
      const pCtx = frame.processedCanvas.getContext('2d');
      pCtx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
      pCtx.drawImage(frame.canvas, 0, 0);
    });
    return;
  }

  if (method === 'ai') {
    if (els.videoLoadingOverlay) {
      els.videoLoadingOverlay.classList.remove('hidden');
      const loadingText = document.getElementById('video-loading-text');
      if (loadingText) loadingText.textContent = 'Initializing AI Background Removal...';
    }

    // Defer a bit so loading screen renders
    await new Promise((resolve) => setTimeout(resolve, 30));

    try {
      const modelSize = state.video.bgRemovalModelSize || 'medium';
      
      for (let i = 0; i < state.video.frames.length; i++) {
        const frame = state.video.frames[i];
        const loadingText = document.getElementById('video-loading-text');
        if (loadingText) {
          loadingText.textContent = `AI Background Removal: Frame ${i + 1}/${state.video.frames.length}`;
        }
        
        if (!frame.aiProcessedCanvas || frame.aiProcessedModelSize !== modelSize) {
          const imglyRemoveBackground = (await import('@imgly/background-removal')).removeBackground;
          
          const canvasBlob = await new Promise((resolve) => {
            frame.canvas.toBlob(resolve, 'image/png');
          });
          
          const blob = await imglyRemoveBackground(canvasBlob, {
            model: modelSize,
            publicPath: new URL('resources/', window.location.href).href,
            progress: (key, current, total) => {
              const pct = Math.round((current / total) * 100);
              if (loadingText) {
                loadingText.textContent = `Downloading AI Model (${key}): ${pct}% (Frame ${i + 1}/${state.video.frames.length})`;
              }
            }
          });
          
          const img = new Image();
          img.src = URL.createObjectURL(blob);
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });
          
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          
          frame.aiProcessedCanvas = canvas;
          frame.aiProcessedModelSize = modelSize;
        }
        
        const pCtx = frame.processedCanvas.getContext('2d');
        pCtx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
        pCtx.drawImage(frame.aiProcessedCanvas, 0, 0);
      }
    } catch (err) {
      console.error(err);
      showToast('AI Error', 'AI Background removal failed: ' + err.message, 'error');
    } finally {
      if (els.videoLoadingOverlay) {
        els.videoLoadingOverlay.classList.add('hidden');
      }
    }
  } else {
    const hex = state.video.bgColor || '#00ff00';
    const targetR = parseInt(hex.slice(1, 3), 16);
    const targetG = parseInt(hex.slice(3, 5), 16);
    const targetB = parseInt(hex.slice(5, 7), 16);
    const tolerance = state.video.bgTolerance || 15;

    const targetYuv = rgbToYuv(targetR, targetG, targetB);
    
    // Calculate target saturation to determine chrominance vs luminance weights dynamically
    const targetSaturation = Math.sqrt((targetYuv.u - 128) ** 2 + (targetYuv.v - 128) ** 2);
    const sat = Math.min(1.0, targetSaturation / 181.0);
    
    // Dynamic weights based on target color saturation
    const wY = 1.0 - (sat * 0.8);
    const wU = 1.0 + (sat * 0.5);
    const wV = 1.0 + (sat * 0.5);

    const toleranceVal = tolerance * 2.2;
    const minThreshold = toleranceVal;
    const featherWidth = Math.min(15, tolerance);
    const maxThreshold = toleranceVal + featherWidth;

    state.video.frames.forEach(frame => {
      const pCtx = frame.processedCanvas.getContext('2d');
      pCtx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
      pCtx.drawImage(frame.canvas, 0, 0);

      const width = frame.canvas.width;
      const height = frame.canvas.height;
      const imgData = pCtx.getImageData(0, 0, width, height);
      const data = imgData.data;

      // Generate contiguous background mask if enabled
      const useContiguous = state.video.bgContiguous !== false;
      const mask = useContiguous
        ? getContiguousBgMask(width, height, data, targetYuv, wY, wU, wV, maxThreshold)
        : null;

      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % width;
        const y = Math.floor((i / 4) / width);
        const idx = y * width + x;

        // Skip if contiguous mode is active and this pixel is not connected to the background
        if (useContiguous && mask[idx] === 0) {
          continue;
        }

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const pixelYuv = rgbToYuv(r, g, b);
        const dist = Math.sqrt(
          wY * ((pixelYuv.y - targetYuv.y) ** 2) +
          wU * ((pixelYuv.u - targetYuv.u) ** 2) +
          wV * ((pixelYuv.v - targetYuv.v) ** 2)
        );

        if (dist <= minThreshold) {
          data[i + 3] = 0; // Transparent
        } else if (dist < maxThreshold) {
          const range = maxThreshold - minThreshold;
          const t = range > 0 ? (dist - minThreshold) / range : 1.0;
          data[i + 3] = Math.min(data[i + 3], Math.floor(t * 255));
        }
      }

      // Run color decontamination to clean up background color outlines/spill
      decontaminateEdges(width, height, data);

      pCtx.putImageData(imgData, 0, 0);
    });
  }
}

function duplicateVideoFrame(index) {
  const frame = state.video.frames.find(f => f.index === index);
  if (!frame) return;

  const canvasCopy = document.createElement('canvas');
  canvasCopy.width = frame.canvas.width;
  canvasCopy.height = frame.canvas.height;
  canvasCopy.getContext('2d').drawImage(frame.canvas, 0, 0);

  const processedCanvasCopy = document.createElement('canvas');
  processedCanvasCopy.width = frame.processedCanvas.width;
  processedCanvasCopy.height = frame.processedCanvas.height;
  processedCanvasCopy.getContext('2d').drawImage(frame.processedCanvas, 0, 0);

  const newFrame = {
    index: state.video.frames.length,
    time: frame.time,
    canvas: canvasCopy,
    processedCanvas: processedCanvasCopy,
    enabled: true
  };

  const currentIdx = state.video.frames.indexOf(frame);
  state.video.frames.splice(currentIdx + 1, 0, newFrame);

  reindexVideoFrames();
  renderVideoFramesGrid();
  updateAnimationPlayer();

  showToast('Success', 'Frame duplicated successfully!', 'success');
}

function deleteVideoFrame(index, cardElement) {
  cardElement.classList.add('removing');
  setTimeout(() => {
    state.video.frames.splice(index, 1);
    reindexVideoFrames();
    renderVideoFramesGrid();
    updateAnimationPlayer();
    showToast('Success', 'Frame removed successfully.', 'info');
  }, 200);
}

function reindexVideoFrames() {
  state.video.frames.forEach((f, idx) => {
    f.index = idx;
  });
}

function renderVideoFramesGrid() {
  if (state.video.frames.length === 0) {
    els.videoFramesGrid.innerHTML = `
      <div id="video-grid-placeholder" class="no-sprites-msg" style="grid-column: 1 / -1; padding: 80px 20px; border: 1px dashed var(--border-color); border-radius: 8px; text-align: center; width: 100%;">
        No video frames loaded. Select a video, set range/interval in the sidebar, and click "Extract Video Frames".
      </div>
    `;
    return;
  }

  els.videoFramesGrid.innerHTML = '';

  state.video.frames.forEach(frame => {
    const card = document.createElement('div');
    card.className = `video-frame-card ${frame.enabled ? '' : 'disabled'}`;
    card.dataset.index = frame.index;
    card.setAttribute('draggable', 'true');

    const badge = document.createElement('span');
    badge.className = 'video-frame-badge';
    badge.textContent = `${frame.time.toFixed(2)}s`;

    const check = document.createElement('span');
    check.className = 'video-frame-check';
    check.textContent = '✓';

    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'video-frame-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Remove Frame';

    const copyBtn = document.createElement('span');
    copyBtn.className = 'video-frame-copy';
    copyBtn.textContent = '❐';
    copyBtn.title = 'Duplicate Frame';

    const img = document.createElement('img');
    img.src = frame.processedCanvas.toDataURL('image/png');

    card.appendChild(badge);
    card.appendChild(check);
    card.appendChild(deleteBtn);
    card.appendChild(copyBtn);
    card.appendChild(img);

    // Click handler
    card.addEventListener('click', async (e) => {
      if (state.isPickingColor) {
        const rect = img.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        const scaleX = frame.canvas.width / rect.width;
        const scaleY = frame.canvas.height / rect.height;

        const x = Math.floor(clickX * scaleX);
        const y = Math.floor(clickY * scaleY);

        if (x >= 0 && x < frame.canvas.width && y >= 0 && y < frame.canvas.height) {
          const frameCtx = frame.canvas.getContext('2d');
          const pixel = frameCtx.getImageData(x, y, 1, 1).data;
          const r = pixel[0];
          const g = pixel[1];
          const b = pixel[2];
          const hex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);

          state.video.bgColor = hex;
          els.videoBgColor.value = hex;

          state.isPickingColor = false;
          const viewport = document.querySelector('#video-viewport-content .canvas-viewport');
          if (viewport) viewport.style.cursor = 'default';
          els.videoBtnPickColor.classList.remove('active');

          showToast('Color Selected', `Sampled color ${hex} from frame.`, 'success');

          await applyVideoBgRemoval();
          renderVideoFramesGrid();
          updateAnimationPlayer();
        }
        return;
      }

      frame.enabled = !frame.enabled;
      if (frame.enabled) {
        card.classList.remove('disabled');
      } else {
        card.classList.add('disabled');
      }
      updateAnimationPlayer();
    });

    // Delete action
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteVideoFrame(frame.index, card);
    });

    // Copy action
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateVideoFrame(frame.index);
    });

    // HTML5 Drag and Drop events
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', frame.index);
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const rect = card.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      if (relX < rect.width / 2) {
        card.classList.add('drag-over-left');
        card.classList.remove('drag-over-right');
      } else {
        card.classList.add('drag-over-right');
        card.classList.remove('drag-over-left');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-left', 'drag-over-right');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over-left', 'drag-over-right');

      const dragIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const dropIdx = parseInt(card.dataset.index);

      if (isNaN(dragIdx) || isNaN(dropIdx) || dragIdx === dropIdx) return;

      const rect = card.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const dropOnLeft = relX < rect.width / 2;

      const draggedFrame = state.video.frames.splice(dragIdx, 1)[0];

      let insertIdx = dropIdx;
      if (!dropOnLeft) {
        insertIdx = dragIdx < dropIdx ? dropIdx : dropIdx + 1;
      } else {
        insertIdx = dragIdx < dropIdx ? dropIdx - 1 : dropIdx;
      }

      insertIdx = Math.max(0, Math.min(state.video.frames.length, insertIdx));
      state.video.frames.splice(insertIdx, 0, draggedFrame);

      reindexVideoFrames();
      renderVideoFramesGrid();
      updateAnimationPlayer();
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.video-frame-card').forEach(c => {
        c.classList.remove('dragging', 'drag-over-left', 'drag-over-right');
      });
    });

    els.videoFramesGrid.appendChild(card);
  });
}

function switchMode(mode) {
  state.activeSettings.mode = mode;
  
  // Reset all mode buttons and panels
  els.modeGrid.classList.remove('active');
  els.modeAuto.classList.remove('active');
  els.modeCustom.classList.remove('active');
  els.settingsGrid.classList.add('hidden');
  els.settingsAuto.classList.add('hidden');
  els.settingsCustom.classList.add('hidden');
  
  if (mode === 'grid') {
    els.modeGrid.classList.add('active');
    els.settingsGrid.classList.remove('hidden');
  } else if (mode === 'auto') {
    els.modeAuto.classList.add('active');
    els.settingsAuto.classList.remove('hidden');
  } else if (mode === 'custom') {
    els.modeCustom.classList.add('active');
    els.settingsCustom.classList.remove('hidden');
    // Exit region selecting mode if active
    exitRegionSelectMode();
    // If no region is set yet, auto-set to full image
    if (!state.activeSettings.customRegion) {
      setRegionToFullImage();
    }
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
  els.optBgRemoval.checked = settings.enableBgRemoval || false;
  els.optBgRemovalMethod.value = settings.bgRemovalMethod || 'chromakey';
  els.optBgRemovalModelSize.value = settings.bgRemovalModelSize || 'medium';
  els.bgColor.value = settings.bgColor || '#00ff00';
  els.bgTolerance.value = settings.bgTolerance || 15;
  els.labelBgTolerance.textContent = `Tolerance (${settings.bgTolerance || 15})`;
  els.optBgContiguous.checked = settings.bgContiguous !== false;

  // Custom Grid UI
  els.customCols.value = settings.customCols || 3;
  els.customRows.value = settings.customRows || 3;
  if (settings.customRegion) {
    els.customRegionX.value = Math.round(settings.customRegion.x);
    els.customRegionY.value = Math.round(settings.customRegion.y);
    els.customRegionW.value = Math.round(settings.customRegion.width);
    els.customRegionH.value = Math.round(settings.customRegion.height);
  } else {
    els.customRegionX.value = 0;
    els.customRegionY.value = 0;
    els.customRegionW.value = 0;
    els.customRegionH.value = 0;
  }

  // Rematch UI
  els.optRematch.checked = settings.rematchEnabled || false;
  els.rematchMode.value = settings.rematchMode || 'largest';
  els.rematchW.value = settings.rematchWidth || 64;
  els.rematchH.value = settings.rematchHeight || 64;
  els.rematchFit.value = settings.rematchFit || 'contain';
  
  if (settings.rematchEnabled) {
    els.rematchSettings.classList.remove('hidden');
  } else {
    els.rematchSettings.classList.add('hidden');
  }
  if (settings.rematchMode === 'custom') {
    els.rematchCustomSize.classList.remove('hidden');
  } else {
    els.rematchCustomSize.classList.add('hidden');
  }

  if (settings.enableBgRemoval || false) {
    els.bgRemovalSettings.classList.remove('hidden');
  } else {
    els.bgRemovalSettings.classList.add('hidden');
  }
  toggleBgRemovalSettingsUI();

  state.activeSettings = { ...settings };
  // Restore array/object references
  if (settings.customRegion) {
    state.activeSettings.customRegion = { ...settings.customRegion };
  }
  state.activeSettings.customColLines = [...(settings.customColLines || [])];
  state.activeSettings.customRowLines = [...(settings.customRowLines || [])];

  // Reset all mode buttons and panels
  els.modeGrid.classList.remove('active');
  els.modeAuto.classList.remove('active');
  els.modeCustom.classList.remove('active');
  els.settingsGrid.classList.add('hidden');
  els.settingsAuto.classList.add('hidden');
  els.settingsCustom.classList.add('hidden');

  if (settings.mode === 'grid') {
    els.modeGrid.classList.add('active');
    els.settingsGrid.classList.remove('hidden');
  } else if (settings.mode === 'auto') {
    els.modeAuto.classList.add('active');
    els.settingsAuto.classList.remove('hidden');
  } else if (settings.mode === 'custom') {
    els.modeCustom.classList.add('active');
    els.settingsCustom.classList.remove('hidden');
  }
}

async function applySettingsToAll() {
  if (state.files.length <= 1) {
    showToast('Info', 'Add more files to use batch settings copy.', 'info');
    return;
  }

  els.loadingOverlay.classList.remove('hidden');
  const textEl = document.getElementById('loading-text');

  try {
    for (let i = 0; i < state.files.length; i++) {
      const f = state.files[i];
      if (textEl) textEl.textContent = `Applying settings to file ${i + 1}/${state.files.length}...`;
      f.settings = { ...state.activeSettings };
      await processImageBackground(f);
      sliceFile(f);
      if (f.id === state.activeFileId) {
        refreshActiveFileView();
      }
    }
    showToast('Settings Applied', 'Configuration copied to all files! Press "Export Batch ZIP" at the bottom right to download.', 'success');
    updateExportStats();

    // Highlight the batch export button to guide user
    els.btnExportAllBatch.classList.remove('pulse-highlight');
    void els.btnExportAllBatch.offsetWidth; // trigger reflow
    els.btnExportAllBatch.classList.add('pulse-highlight');
  } catch (err) {
    console.error(err);
    showToast('Error', 'Batch settings failed: ' + err.message, 'error');
  } finally {
    els.loadingOverlay.classList.add('hidden');
  }
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
  const totalFiles = fileList.length;

  for (let i = 0; i < totalFiles; i++) {
    const file = fileList[i];
    
    // Redirect video drop/select to Video Extractor tab
    if (file.type.startsWith('video/')) {
      switchWorkspaceMode('video');
      loadVideoFile(file);
      showToast('Video Switch', `Redirected to Video Extractor workspace to process ${file.name}.`, 'info');
      continue;
    }

    if (!file.type.startsWith('image/')) {
      showToast('Error', `${file.name} is not a supported image file.`, 'error');
      continue;
    }

    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.onload = async () => {
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

        els.loadingOverlay.classList.remove('hidden');
        const textEl = document.getElementById('loading-text');
        if (textEl) textEl.textContent = 'Processing background removal...';

        try {
          await processImageBackground(fileObj);
          sliceFile(fileObj);
          addFileToSidebar(fileObj);

          // Auto select the first loaded file if none is active
          if (!state.activeFileId) {
            selectFile(fileId);
          }

          showToast('Loaded Successfully', `Imported ${file.name}`, 'success');
          updateExportStats();
        } catch (err) {
          console.error(err);
          showToast('Error', `Background removal failed: ${err.message}`, 'error');
        } finally {
          els.loadingOverlay.classList.add('hidden');
        }
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
let processingQueue = Promise.resolve();

async function processImageBackground(fileObj) {
  const settings = fileObj.settings;
  if (!settings.enableBgRemoval) {
    fileObj.processedCanvas = null;
    return;
  }

  // Queue background removal processing to prevent concurrent model executions (WebGL context issues)
  const myTurn = new Promise((resolve) => {
    processingQueue.then(resolve);
  });
  let nextResolve;
  processingQueue = new Promise((resolve) => {
    nextResolve = resolve;
  });
  await myTurn;

  try {
    if (settings.bgRemovalMethod === 'ai') {
      const modelSize = settings.bgRemovalModelSize || 'medium';
      if (!fileObj.aiProcessedCanvas || fileObj.aiProcessedModelSize !== modelSize) {
        const textEl = document.getElementById('loading-text');
        if (textEl) textEl.textContent = 'Initializing AI Background Removal...';

        const imglyRemoveBackground = (await import('@imgly/background-removal')).removeBackground;

        let inputSource = fileObj.file;
        if (!inputSource) {
          const canvas = document.createElement('canvas');
          canvas.width = fileObj.imgElement.naturalWidth;
          canvas.height = fileObj.imgElement.naturalHeight;
          canvas.getContext('2d').drawImage(fileObj.imgElement, 0, 0);
          inputSource = await new Promise((resolve) => {
            canvas.toBlob(resolve, 'image/png');
          });
        }

        const blob = await imglyRemoveBackground(inputSource, {
          model: modelSize,
          publicPath: new URL('resources/', window.location.href).href,
          progress: (key, current, total) => {
            const pct = Math.round((current / total) * 100);
            if (textEl) {
              textEl.textContent = `Downloading AI Model (${key}): ${pct}%`;
            }
          }
        });

        const img = new Image();
        img.src = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        fileObj.aiProcessedCanvas = canvas;
        fileObj.aiProcessedModelSize = modelSize;
      }
      fileObj.processedCanvas = fileObj.aiProcessedCanvas;
    } else {
      const img = fileObj.imgElement;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const width = canvas.width;
      const height = canvas.height;
      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;

      const hex = settings.bgColor || '#00ff00';
      const targetR = parseInt(hex.slice(1, 3), 16);
      const targetG = parseInt(hex.slice(3, 5), 16);
      const targetB = parseInt(hex.slice(5, 7), 16);
      const tolerance = settings.bgTolerance || 15;

      const targetYuv = rgbToYuv(targetR, targetG, targetB);

      const targetSaturation = Math.sqrt((targetYuv.u - 128) ** 2 + (targetYuv.v - 128) ** 2);
      const sat = Math.min(1.0, targetSaturation / 181.0);

      const wY = 1.0 - (sat * 0.8);
      const wU = 1.0 + (sat * 0.5);
      const wV = 1.0 + (sat * 0.5);

      const toleranceVal = tolerance * 2.2;
      const minThreshold = toleranceVal;
      const featherWidth = Math.min(15, tolerance);
      const maxThreshold = toleranceVal + featherWidth;

      const useContiguous = settings.bgContiguous !== false;
      const mask = useContiguous
        ? getContiguousBgMask(width, height, data, targetYuv, wY, wU, wV, maxThreshold)
        : null;

      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % width;
        const y = Math.floor((i / 4) / width);
        const idx = y * width + x;

        if (useContiguous && mask[idx] === 0) {
          continue;
        }

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const pixelYuv = rgbToYuv(r, g, b);
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

      decontaminateEdges(width, height, data);
      ctx.putImageData(imgData, 0, 0);
      fileObj.processedCanvas = canvas;
    }
  } finally {
    nextResolve();
  }
}

function sliceFile(fileObj) {
  const imgSource = fileObj.processedCanvas || fileObj.imgElement;

  const mode = fileObj.settings.mode;
  if (mode === 'grid') {
    fileObj.slices = sliceGrid(
      imgSource,
      fileObj.settings.gridW,
      fileObj.settings.gridH,
      fileObj.settings.skipEmpty,
      fileObj.settings.autoTolerance
    );
  } else if (mode === 'custom') {
    const region = fileObj.settings.customRegion;
    if (region && region.width > 0 && region.height > 0) {
      fileObj.slices = sliceCustomGrid(
        imgSource,
        region,
        fileObj.settings.customColLines || [],
        fileObj.settings.customRowLines || [],
        fileObj.settings.skipEmpty,
        fileObj.settings.autoTolerance
      );
    } else {
      fileObj.slices = [];
    }
  } else {
    fileObj.slices = sliceAuto(
      imgSource,
      fileObj.settings.autoMinW,
      fileObj.settings.autoMinH,
      fileObj.settings.autoTolerance,
      fileObj.settings.autoRowGap
    );
  }
}

async function reSliceActiveFile() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const textEl = document.getElementById('loading-text');
  if (textEl) textEl.textContent = 'Processing background removal...';
  els.loadingOverlay.classList.remove('hidden');

  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    await processImageBackground(activeFile);
    sliceFile(activeFile);
    refreshActiveFileView();
  } catch (err) {
    console.error(err);
    showToast('Error', 'Background removal failed: ' + err.message, 'error');
  } finally {
    els.loadingOverlay.classList.add('hidden');
  }
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
// ----------------------------------------------------
function clearCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.canvas.width = 0;
  els.canvas.height = 0;
}

// ----------------------------------------------------
// Custom Grid Functions
// ----------------------------------------------------

/** Sync custom region from the numeric inputs */
function syncCustomRegionFromUI() {
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
function setRegionToFullImage() {
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
function generateEqualDividers() {
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

/** Toggle region selection mode */
function toggleRegionSelectMode() {
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
function exitRegionSelectMode() {
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
function drawCustomGridOverlay(canvasW, canvasH) {
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
function handleCustomGridMouseDown(e, coords) {
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
function handleCustomGridMouseMove(e, coords) {
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
      
      // Proportionally scale inner divider lines
      const scaleX = newW / region.width;
      const scaleY = newH / region.height;

      if (state.activeSettings.customColLines) {
        state.activeSettings.customColLines = state.activeSettings.customColLines.map(x => newX + (x - region.x) * scaleX);
      }
      if (state.activeSettings.customRowLines) {
        state.activeSettings.customRowLines = state.activeSettings.customRowLines.map(y => newY + (y - region.y) * scaleY);
      }
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
function handleCustomGridMouseUp(e, coords) {
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

function drawCanvas() {
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
    
    const imgSource = activeFile.processedCanvas || activeFile.imgElement;
    tempCtx.drawImage(
      imgSource,
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

  // Update animation player setup when slices/previews update
  updateAnimationPlayer();
}

// ----------------------------------------------------
// Preview Tab Switching & Animation Playback
// ----------------------------------------------------
function switchPreviewTab(tab) {
  state.anim.activeTab = tab;

  if (tab === 'slices') {
    els.tabSlices.classList.add('active');
    els.tabAnimation.classList.remove('active');
    
    // Inline styling correction for tabs
    els.tabSlices.style.borderBottomColor = 'var(--primary)';
    els.tabSlices.style.color = 'var(--text-main)';
    els.tabAnimation.style.borderBottomColor = 'transparent';
    els.tabAnimation.style.color = 'var(--text-muted)';

    els.viewSlices.classList.remove('hidden');
    els.viewAnimation.classList.add('hidden');

    // Show standard export footer
    document.querySelector('.export-footer').classList.remove('hidden');

    stopAnimPlayback();
  } else {
    els.tabSlices.classList.remove('active');
    els.tabAnimation.classList.add('active');

    els.tabSlices.style.borderBottomColor = 'transparent';
    els.tabSlices.style.color = 'var(--text-muted)';
    els.tabAnimation.style.borderBottomColor = 'var(--primary)';
    els.tabAnimation.style.color = 'var(--text-main)';

    els.viewSlices.classList.add('hidden');
    els.viewAnimation.classList.remove('hidden');

    // Hide standard export footer
    document.querySelector('.export-footer').classList.add('hidden');

    updateAnimationPlayer();
    startAnimPlayback();
  }
}

function startAnimPlayback() {
  if (state.anim.isPlaying) return;
  state.anim.isPlaying = true;
  els.btnAnimPlay.textContent = 'Pause';
  tickAnimPlayback();
}

function stopAnimPlayback() {
  state.anim.isPlaying = false;
  els.btnAnimPlay.textContent = 'Play';
  if (state.anim.timer) {
    clearTimeout(state.anim.timer);
    state.anim.timer = null;
  }
}

function toggleAnimPlayback() {
  if (state.anim.isPlaying) {
    stopAnimPlayback();
  } else {
    startAnimPlayback();
  }
}

function handleAnimFpsChange(e) {
  const fps = parseInt(e.target.value) || 10;
  state.anim.fps = fps;
  els.labelAnimFps.querySelector('strong').textContent = `${fps} FPS`;
  
  if (state.anim.isPlaying) {
    stopAnimPlayback();
    startAnimPlayback();
  }
}

function tickAnimPlayback() {
  if (!state.anim.isPlaying) return;

  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) {
      stopAnimPlayback();
      return;
    }
    state.anim.currentFrame = (state.anim.currentFrame + 1) % enabledFrames.length;
    drawAnimFrame();
    state.anim.timer = setTimeout(tickAnimPlayback, 1000 / state.anim.fps);
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) {
    stopAnimPlayback();
    return;
  }

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) {
    stopAnimPlayback();
    return;
  }

  state.anim.currentFrame = (state.anim.currentFrame + 1) % enabledSlices.length;
  drawAnimFrame();

  state.anim.timer = setTimeout(tickAnimPlayback, 1000 / state.anim.fps);
}

function updateAnimationPlayer() {
  if (state.workspaceMode === 'video') {
    if (state.video.frames.length === 0) {
      els.animCanvas.style.display = 'none';
      els.animNoFramesMsg.style.display = 'block';
      els.btnExportGif.disabled = true;
      els.btnExportWebm.disabled = true;
      els.animFrameIdx.textContent = '0';
      els.animFrameTotal.textContent = '0';
      stopAnimPlayback();
      return;
    }

    const enabledFrames = state.video.frames.filter(f => f.enabled);
    els.animFrameTotal.textContent = enabledFrames.length;

    if (enabledFrames.length === 0) {
      els.animCanvas.style.display = 'none';
      els.animNoFramesMsg.style.display = 'block';
      els.btnExportGif.disabled = true;
      els.btnExportWebm.disabled = true;
      els.animFrameIdx.textContent = '0';
      stopAnimPlayback();
    } else {
      els.animCanvas.style.display = 'block';
      els.animNoFramesMsg.style.display = 'none';
      els.btnExportGif.disabled = false;
      els.btnExportWebm.disabled = false;

      if (state.anim.currentFrame >= enabledFrames.length) {
        state.anim.currentFrame = 0;
      }
      
      drawAnimFrame();
      if (state.anim.isPlaying && state.anim.activeTab === 'animation') {
        if (!state.anim.timer) {
          state.anim.isPlaying = false;
          startAnimPlayback();
        }
      }
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) {
    els.animCanvas.style.display = 'none';
    els.animNoFramesMsg.style.display = 'block';
    els.btnExportGif.disabled = true;
    els.btnExportWebm.disabled = true;
    els.animFrameIdx.textContent = '0';
    els.animFrameTotal.textContent = '0';
    stopAnimPlayback();
    return;
  }

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  els.animFrameTotal.textContent = enabledSlices.length;

  if (enabledSlices.length === 0) {
    els.animCanvas.style.display = 'none';
    els.animNoFramesMsg.style.display = 'block';
    els.btnExportGif.disabled = true;
    els.btnExportWebm.disabled = true;
    els.animFrameIdx.textContent = '0';
    stopAnimPlayback();
  } else {
    els.animCanvas.style.display = 'block';
    els.animNoFramesMsg.style.display = 'none';
    els.btnExportGif.disabled = false;
    els.btnExportWebm.disabled = false;

    if (state.anim.currentFrame >= enabledSlices.length) {
      state.anim.currentFrame = 0;
    }
    
    drawAnimFrame();
    if (state.anim.isPlaying && state.anim.activeTab === 'animation') {
      if (!state.anim.timer) {
        state.anim.isPlaying = false;
        startAnimPlayback();
      }
    }
  }
}

function drawAnimFrame() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    if (state.anim.currentFrame >= enabledFrames.length) {
      state.anim.currentFrame = 0;
    }

    const frame = enabledFrames[state.anim.currentFrame];
    if (!frame) return;

    els.animFrameIdx.textContent = state.anim.currentFrame + 1;

    els.animCanvas.width = frame.canvas.width;
    els.animCanvas.height = frame.canvas.height;
    const animCtx = els.animCanvas.getContext('2d');
    animCtx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
    animCtx.drawImage(frame.processedCanvas, 0, 0);
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  const slice = enabledSlices[state.anim.currentFrame];
  if (!slice) return;

  els.animFrameIdx.textContent = state.anim.currentFrame + 1;

  els.animCanvas.width = slice.width;
  els.animCanvas.height = slice.height;
  const animCtx = els.animCanvas.getContext('2d');
  animCtx.clearRect(0, 0, slice.width, slice.height);

  const imgSource = activeFile.processedCanvas || activeFile.imgElement;
  animCtx.drawImage(
    imgSource,
    slice.x, slice.y, slice.width, slice.height,
    0, 0, slice.width, slice.height
  );
}

function exportAnimationGif() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    showProgressBar(true);
    updateProgressBar('Preparing frames for GIF conversion...', 10);

    const images = [];
    try {
      for (let i = 0; i < enabledFrames.length; i++) {
        const frame = enabledFrames[i];
        images.push(frame.processedCanvas.toDataURL('image/png'));
      }

      updateProgressBar('Generating GIF file...', 50);

      gifshot.createGIF({
        images: images,
        interval: 1 / state.anim.fps,
        gifWidth: enabledFrames[0].canvas.width,
        gifHeight: enabledFrames[0].canvas.height,
        numWorkers: 2
      }, function (obj) {
        showProgressBar(false);
        if (!obj.error) {
          const link = document.createElement('a');
          link.href = obj.image;
          const cleanName = state.video.file.name.substring(0, state.video.file.name.lastIndexOf('.')) || 'video';
          link.download = `${cleanName}_animation.gif`;
          link.click();
          showToast('Success', 'GIF animation exported successfully!', 'success');
        } else {
          console.error(obj.error);
          showToast('GIF Error', 'Failed to compile GIF frames.', 'error');
        }
      });
    } catch (err) {
      console.error(err);
      showProgressBar(false);
      showToast('GIF Error', 'Failed to generate GIF file.', 'error');
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Preparing frames for GIF conversion...', 10);

  const images = [];
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  const imgSource = activeFile.processedCanvas || activeFile.imgElement;

  try {
    for (let i = 0; i < enabledSlices.length; i++) {
      const slice = enabledSlices[i];
      tempCanvas.width = slice.width;
      tempCanvas.height = slice.height;
      tempCtx.clearRect(0, 0, slice.width, slice.height);
      tempCtx.drawImage(
        imgSource,
        slice.x, slice.y, slice.width, slice.height,
        0, 0, slice.width, slice.height
      );
      images.push(tempCanvas.toDataURL('image/png'));
    }

    updateProgressBar('Generating GIF file...', 50);

    gifshot.createGIF({
      images: images,
      interval: 1 / state.anim.fps,
      gifWidth: enabledSlices[0].width,
      gifHeight: enabledSlices[0].height,
      numWorkers: 2
    }, function (obj) {
      showProgressBar(false);
      if (!obj.error) {
        const link = document.createElement('a');
        link.href = obj.image;
        const cleanName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
        link.download = `${cleanName}_animation.gif`;
        link.click();
        showToast('Success', 'GIF animation exported successfully!', 'success');
      } else {
        console.error(obj.error);
        showToast('GIF Error', 'Failed to compile GIF frames.', 'error');
      }
    });

  } catch (err) {
    console.error(err);
    showProgressBar(false);
    showToast('GIF Error', 'Failed to generate GIF file.', 'error');
  }
}

function exportAnimationWebm() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    showProgressBar(true);
    updateProgressBar('Recording WebM canvas stream...', 0);

    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = enabledFrames[0].canvas.width;
      tempCanvas.height = enabledFrames[0].canvas.height;
      const tempCtx = tempCanvas.getContext('2d');

      const stream = tempCanvas.captureStream(state.anim.fps);
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const cleanName = state.video.file.name.substring(0, state.video.file.name.lastIndexOf('.')) || 'video';
        link.download = `${cleanName}_animation.webm`;
        link.click();
        showProgressBar(false);
        showToast('Success', 'WebM animation exported successfully!', 'success');
      };

      mediaRecorder.start();

      let frameIdx = 0;

      const recordInterval = setInterval(() => {
        if (frameIdx >= enabledFrames.length) {
          clearInterval(recordInterval);
          mediaRecorder.stop();
          return;
        }

        const frame = enabledFrames[frameIdx];
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(frame.processedCanvas, 0, 0);

        frameIdx++;
        updateProgressBar(`Recording frame ${frameIdx}/${enabledFrames.length}`, Math.round((frameIdx / enabledFrames.length) * 100));
      }, 1000 / state.anim.fps);

    } catch (err) {
      console.error(err);
      showProgressBar(false);
      showToast('WebM Error', 'Failed to generate WebM file.', 'error');
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Recording WebM canvas stream...', 0);

  try {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = enabledSlices[0].width;
    tempCanvas.height = enabledSlices[0].height;
    const tempCtx = tempCanvas.getContext('2d');

    const stream = tempCanvas.captureStream(state.anim.fps);
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const cleanName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
      link.download = `${cleanName}_animation.webm`;
      link.click();
      showProgressBar(false);
      showToast('Success', 'WebM animation exported successfully!', 'success');
    };

    mediaRecorder.start();

    const imgSource = activeFile.processedCanvas || activeFile.imgElement;
    let frameIdx = 0;

    const recordInterval = setInterval(() => {
      if (frameIdx >= enabledSlices.length) {
        clearInterval(recordInterval);
        mediaRecorder.stop();
        return;
      }

      const slice = enabledSlices[frameIdx];
      tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
      tempCtx.drawImage(
        imgSource,
        slice.x, slice.y, slice.width, slice.height,
        0, 0, tempCanvas.width, tempCanvas.height
      );

      frameIdx++;
      updateProgressBar(`Recording frame ${frameIdx}/${enabledSlices.length}`, Math.round((frameIdx / enabledSlices.length) * 100));
    }, 1000 / state.anim.fps);

  } catch (err) {
    console.error(err);
    showProgressBar(false);
    showToast('WebM Error', 'Failed to generate WebM file.', 'error');
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
function getSliceBlob(fileObj, slice) {
  return new Promise((resolve) => {
    const s = fileObj.settings;
    let targetW = slice.width;
    let targetH = slice.height;

    // Apply Rematch if enabled
    if (s.rematchEnabled) {
      if (s.rematchMode === 'custom') {
        targetW = s.rematchWidth;
        targetH = s.rematchHeight;
      } else if (s.rematchMode === 'largest') {
        // Find largest slice in this file
        let maxW = 0;
        let maxH = 0;
        fileObj.slices.forEach(sl => {
          if (sl.width > maxW) maxW = sl.width;
          if (sl.height > maxH) maxH = sl.height;
        });
        targetW = maxW;
        targetH = maxH;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    
    const imgSource = fileObj.processedCanvas || fileObj.imgElement;
    
    if (!s.rematchEnabled) {
      // Normal export
      ctx.drawImage(
        imgSource,
        slice.x, slice.y, slice.width, slice.height,
        0, 0, slice.width, slice.height
      );
    } else {
      // Rematched export
      const fit = s.rematchFit || 'contain';
      let dx = 0, dy = 0, dw = targetW, dh = targetH;

      if (fit === 'stretch') {
        // Stretch ignores aspect ratio
        ctx.drawImage(
          imgSource,
          slice.x, slice.y, slice.width, slice.height,
          0, 0, targetW, targetH
        );
      } else {
        // Keep aspect ratio for contain/cover
        const ratioSrc = slice.width / slice.height;
        const ratioDst = targetW / targetH;

        if (fit === 'contain') {
          if (ratioSrc > ratioDst) {
            // Source is wider, fit width
            dw = targetW;
            dh = targetW / ratioSrc;
            dy = (targetH - dh) / 2;
          } else {
            // Source is taller, fit height
            dh = targetH;
            dw = targetH * ratioSrc;
            dx = (targetW - dw) / 2;
          }
        } else if (fit === 'cover') {
          if (ratioSrc > ratioDst) {
            // Source is wider, fill height, crop width
            dh = targetH;
            dw = targetH * ratioSrc;
            dx = (targetW - dw) / 2; // will be negative
          } else {
            // Source is taller, fill width, crop height
            dw = targetW;
            dh = targetW / ratioSrc;
            dy = (targetH - dh) / 2; // will be negative
          }
        }
        
        ctx.drawImage(
          imgSource,
          slice.x, slice.y, slice.width, slice.height,
          Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh)
        );
      }
    }
    
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
      const blob = await getSliceBlob(activeFile, slice);
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
        const blob = await getSliceBlob(fileObj, slice);
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
