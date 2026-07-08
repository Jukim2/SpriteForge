import { extractFrames, resolveVideoDuration } from '../videoExtractor.js';
import { chromaKeyCanvas } from '../chromakey.js';
import { state } from '../app/state.js';
import { els } from '../app/dom.js';
import { detectCornerColor } from '../app/utils.js';
import { showToast, showProgressBar, updateProgressBar } from '../app/ui.js';
import { switchWorkspaceMode } from '../app/workspace.js';
import { updateAnimationPlayer } from './animPlayer.js';
import { addCanvasesToImgTools } from './imgtools.js';

// ----------------------------------------------------
// Video Workspace (frame extraction + bg removal)
// ----------------------------------------------------

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


function handleVideoFileSelect(e) {
  if (e.target.files.length > 0) {
    loadVideoFile(e.target.files[0]);
  }
  els.videoFileInput.value = ''; // Reset input
}

export function loadVideoFile(file) {
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

    els.wsVideoPlayer.onloadedmetadata = async () => {
      // MediaRecorder-produced WebM can report Infinity until forced to scan.
      const duration = await resolveVideoDuration(els.wsVideoPlayer);
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
  const interval = parseFloat(els.videoIntervalInput.value) || 0.2;

  if (start >= end) {
    showToast('Range Error', 'Start time must be less than End time.', 'error');
    return;
  }

  const useAllFrames = els.videoOptAllFrames && els.videoOptAllFrames.checked;

  showProgressBar(true);
  updateProgressBar('Initializing frames extraction...', 0);
  const loadingText = document.getElementById('video-loading-text');
  if (els.videoLoadingOverlay) {
    els.videoLoadingOverlay.classList.remove('hidden');
    if (loadingText) loadingText.textContent = 'Initializing frames extraction...';
  }

  try {
    const rawFrames = await extractFrames({
      url: state.video.url,
      start,
      end,
      mode: useAllFrames ? 'all' : 'interval',
      interval,
      onProgress: ({ label, percent }) => {
        updateProgressBar(label, percent);
        if (loadingText) loadingText.textContent = label;
      }
    });

    if (rawFrames.length === 0) {
      throw new Error('No frames found in the specified range.');
    }

    // Attach a processed canvas (background removal target) to each frame
    state.video.frames = rawFrames.map(frame => {
      const processedCanvas = document.createElement('canvas');
      processedCanvas.width = frame.canvas.width;
      processedCanvas.height = frame.canvas.height;
      processedCanvas.getContext('2d').drawImage(frame.canvas, 0, 0);
      return { ...frame, processedCanvas };
    });

    // Apply background removal if enabled
    await applyVideoBgRemoval();

    // Render grid
    renderVideoFramesGrid();

    // Reset and initialize animation preview
    state.anim.currentFrame = 0;
    updateAnimationPlayer();

    showToast('Success', `Extracted ${state.video.frames.length} frames successfully.`, 'success');
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
    const keyOptions = {
      color: state.video.bgColor || '#00ff00',
      tolerance: state.video.bgTolerance || 15,
      contiguous: state.video.bgContiguous !== false
    };

    for (let i = 0; i < state.video.frames.length; i++) {
      const frame = state.video.frames[i];
      chromaKeyCanvas(frame.canvas, frame.processedCanvas.getContext('2d'), keyOptions);
      // Yield to the event loop every few frames so the UI stays responsive
      // during long sequences.
      if (i % 4 === 3) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
}

// Hand the enabled (background-removed) frames to Image Tools for further
// processing — upscale, AI bg-removal, compression — without exporting first.
function sendVideoFramesToImgTools() {
  const frames = state.video.frames.filter(f => f.enabled);
  if (frames.length === 0) {
    showToast('No Frames', 'Extract video frames (and keep at least one enabled) first.', 'warning');
    return;
  }
  const base = (state.video.file?.name || 'video').replace(/\.[^.]+$/, '');
  const items = frames.map(f => ({
    name: `${base}_frame_${String(f.index + 1).padStart(3, '0')}.png`,
    canvas: f.processedCanvas
  }));
  addCanvasesToImgTools(items);
  switchWorkspaceMode('imgtools');
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

export function bindVideoEvents() {
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
  els.btnVideoToImgTools.addEventListener('click', sendVideoFramesToImgTools);

  els.wsVideoPlayer.addEventListener('timeupdate', () => {
    updateVideoTimeDisplay();
  });

  // Video Auto-Detect Background Color
  els.videoBtnAutoDetectBg.addEventListener('click', (e) => {
    e.stopPropagation();
    autoDetectVideoBgColor();
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
