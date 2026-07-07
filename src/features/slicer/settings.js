// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { detectGridSize } from '../../slicer.js';
import { state, getActiveFile } from '../../app/state.js';
import { els } from '../../app/dom.js';
import { debounce, detectCornerColor } from '../../app/utils.js';
import { showToast } from '../../app/ui.js';
import { updateExportStats } from '../exporter.js';
import { processImageBackground, sliceFile, reSliceActiveFile, refreshActiveFileView } from './process.js';
import {
  toggleRegionSelectMode, exitRegionSelectMode, setRegionToFullImage,
  syncCustomRegionFromUI, generateEqualDividers, autoSnapDividers, autoSnapDividersKeep
} from './customGrid.js';

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

// ----------------------------------------------------
// UI Settings Synchronization
// ----------------------------------------------------
export function syncSettingsFromUI() {
  state.activeSettings.gridW = Math.max(1, parseInt(els.gridW.value) || 32);
  state.activeSettings.gridH = Math.max(1, parseInt(els.gridH.value) || 32);
  state.activeSettings.autoMinW = Math.max(1, parseInt(els.autoMinW.value) || 8);
  state.activeSettings.autoMinH = Math.max(1, parseInt(els.autoMinH.value) || 8);
  state.activeSettings.autoTolerance = Math.min(255, Math.max(0, parseInt(els.autoTolerance.value) || 0));
  state.activeSettings.autoRowGap = Math.max(0, parseInt(els.autoRowGap.value) || 0);
  state.activeSettings.autoMergeGap = Math.min(128, Math.max(0, parseInt(els.autoMergeGap.value) || 0));
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

export function updateSettingsUI(settings) {
  if (!settings) return;
  
  els.gridW.value = settings.gridW;
  els.gridH.value = settings.gridH;
  els.autoMinW.value = settings.autoMinW;
  els.autoMinH.value = settings.autoMinH;
  els.autoTolerance.value = settings.autoTolerance;
  els.autoRowGap.value = settings.autoRowGap;
  els.autoMergeGap.value = settings.autoMergeGap || 0;
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

export function bindSlicerSettingsEvents() {
  // Mode Select Buttons
  els.modeGrid.addEventListener('click', () => switchMode('grid'));
  els.modeAuto.addEventListener('click', () => switchMode('auto'));
  els.modeCustom.addEventListener('click', () => switchMode('custom'));

  const debouncedReSlice = debounce(() => {
    syncSettingsFromUI();
    reSliceActiveFile();
  }, 350);

  // Configuration inputs changes (debounced for text/numbers, immediate for checkbox)
  const textInputs = [
    els.gridW, els.gridH, els.autoMinW, els.autoMinH,
    els.autoTolerance, els.autoRowGap, els.autoMergeGap, els.optNaming
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
  els.btnAutoSnap.addEventListener('click', autoSnapDividers);
  els.btnSnapKeep.addEventListener('click', autoSnapDividersKeep);
  
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

  // Slicer Auto-Detect Background Color
  els.btnAutoDetectBg.addEventListener('click', (e) => {
    e.stopPropagation();
    autoDetectSlicerBgColor();
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
}
