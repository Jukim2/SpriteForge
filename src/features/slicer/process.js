// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { sliceGrid, sliceAuto, sliceCustomGrid } from '../../slicer.js';
import { chromaKeyCanvas } from '../../chromakey.js';
import { state, getActiveFile, processingQueue } from '../../app/state.js';
import { els, ctx } from '../../app/dom.js';
import { showToast } from '../../app/ui.js';
import { updateExportStats } from '../exporter.js';
import { drawCanvas } from './canvas.js';
import { renderPreviews } from './previews.js';

// ----------------------------------------------------
// Slicing Logic Execution
// ----------------------------------------------------

export async function processImageBackground(fileObj) {
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

export function sliceFile(fileObj) {
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

export async function reSliceActiveFile() {
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

export function refreshActiveFileView() {
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
export function clearCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.canvas.width = 0;
  els.canvas.height = 0;
}
