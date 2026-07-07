import { sliceGrid, sliceAuto, sliceCustomGrid, isRegionEmpty, detectGridSize } from './slicer.js';
import { chromaKeyCanvas } from './chromakey.js';
import { state, getActiveFile, processingQueue } from './app/state.js';
import { els, ctx } from './app/dom.js';
import { debounce, detectCornerColor, encodeCanvasToBlob, formatBytes, downloadBlob } from './app/utils.js';
import { showToast, showProgressBar, updateProgressBar, setOnProgressHidden } from './app/ui.js';
import { bindImgToolsEvents, updateImgToolsSettingsUI, renderImgToolsView } from './features/imgtools.js';
import { bindExportEvents, updateExportStats } from './features/exporter.js';
import { bindAnimEvents, switchPreviewTab, stopAnimPlayback, updateAnimationPlayer } from './features/animPlayer.js';
import { bindVideoEvents, loadVideoFile } from './features/video.js';

// Initialize App
function init() {
  bindEvents();
  setOnProgressHidden(updateExportStats);
  syncSettingsFromUI();
  updateExportStats();
  updateImgToolsSettingsUI();
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
  bindExportEvents();
  bindAnimEvents();

  // Workspace Switching Events
  els.wsBtnSlicer.addEventListener('click', () => switchWorkspaceMode('slicer'));
  els.wsBtnVideo.addEventListener('click', () => switchWorkspaceMode('video'));
  els.wsBtnImgTools.addEventListener('click', () => switchWorkspaceMode('imgtools'));

  // Video workspace events
  bindVideoEvents();

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


  // Image Tools workspace events
  bindImgToolsEvents();
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

  // Workspace switcher button states
  els.wsBtnSlicer.classList.toggle('active', mode === 'slicer');
  els.wsBtnVideo.classList.toggle('active', mode === 'video');
  if (els.wsBtnImgTools) els.wsBtnImgTools.classList.toggle('active', mode === 'imgtools');

  // Sidebar / viewport visibility
  els.slicerSidebarContent.classList.toggle('hidden', mode !== 'slicer');
  els.videoSidebarContent.classList.toggle('hidden', mode !== 'video');
  if (els.imgToolsSidebarContent) els.imgToolsSidebarContent.classList.toggle('hidden', mode !== 'imgtools');
  els.slicerViewportContent.classList.toggle('hidden', mode !== 'slicer');
  els.videoViewportContent.classList.toggle('hidden', mode !== 'video');
  if (els.imgToolsViewportContent) els.imgToolsViewportContent.classList.toggle('hidden', mode !== 'imgtools');

  // The right preview panel is shared: slicer/video use the tabbed slices/animation
  // views + export footer; image tools swaps in its own export view.
  const previewPanel = document.querySelector('.preview-panel');
  if (previewPanel) previewPanel.style.display = '';
  const isImgTools = mode === 'imgtools';
  document.querySelector('.preview-tabs')?.classList.toggle('hidden', isImgTools);
  if (els.imgToolsOutputContent) els.imgToolsOutputContent.classList.toggle('hidden', !isImgTools);

  if (mode === 'slicer') {
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
  } else if (mode === 'video') {
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
  } else {
    // Image Tools mode
    els.wsVideoPlayer.pause();
    stopAnimPlayback();
    // Hide the slicer/video-specific right-panel content; the image-tools
    // export view is shown via #imgtools-output-content above.
    document.getElementById('view-slices')?.classList.add('hidden');
    document.getElementById('view-animation')?.classList.add('hidden');
    document.querySelector('.export-footer')?.classList.add('hidden');
    renderImgToolsView();
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

function updateSettingsUI(settings) {
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

async function processImageBackground(fileObj) {
  const settings = fileObj.settings;
  if (!settings.enableBgRemoval) {
    fileObj.processedCanvas = null;
    return;
  }

  // Queue background removal processing to prevent concurrent model executions (WebGL context issues)
  const myTurn = new Promise((resolve) => {
    processingQueue.current.then(resolve);
  });
  let nextResolve;
  processingQueue.current = new Promise((resolve) => {
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
      const source = document.createElement('canvas');
      source.width = img.naturalWidth;
      source.height = img.naturalHeight;
      source.getContext('2d').drawImage(img, 0, 0);

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      chromaKeyCanvas(source, canvas.getContext('2d'), {
        color: settings.bgColor || '#00ff00',
        tolerance: settings.bgTolerance || 15,
        contiguous: settings.bgContiguous !== false
      });
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
      fileObj.settings.autoRowGap,
      fileObj.settings.autoMergeGap || 0
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
function autoSnapDividers() {
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
function autoSnapDividersKeep() {
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

function toggleAllSlices() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const anyEnabled = activeFile.slices.some(s => s.enabled);
  activeFile.slices.forEach(s => s.enabled = !anyEnabled);

  drawCanvas();
  renderPreviews();
  updateExportStats();
}




// Start the Application
window.addEventListener('DOMContentLoaded', init);
