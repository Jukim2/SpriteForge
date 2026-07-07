import JSZip from 'jszip';
import { upscaleImage, AI_MODELS, getAiBackend } from '../upscaler.js';
import { segmentBackground, isSegModel, BG_SEG_MODELS } from '../bgSegmenter.js';
import { vectorizeImage, svgToDataUrl } from '../vectorizer.js';
import { state, processingQueue } from '../app/state.js';
import { els } from '../app/dom.js';
import { encodeCanvasToBlob, formatBytes, downloadBlob } from '../app/utils.js';
import { showToast } from '../app/ui.js';

// ----------------------------------------------------
// Image Tools Workspace (Upscale / Vectorize)
// ----------------------------------------------------

function getActiveImgToolsFile() {
  return state.imgTools.files.find(f => f.id === state.imgTools.activeId) || null;
}

function syncImgToolsSettingsFromUI() {
  const s = state.imgTools.settings;
  s.upscaleAlgorithm = els.upscaleAlgorithm.value;
  s.upscaleAiModel = els.upscaleAiModel.value;
  s.upscaleScale = parseInt(els.upscaleScale.value) || 4;
  s.upscaleFormat = els.upscaleFormat.value;
  s.upscaleQuality = parseInt(els.upscaleQuality.value) || 90;
  s.bgModel = els.bgremoveModel.value;
  s.bgFormat = els.bgremoveFormat.value;
  s.bgQuality = parseInt(els.bgremoveQuality.value) || 90;
  s.vectorMode = els.vectorMode.value;
  s.vectorPreset = els.vectorPreset.value;
  s.vectorColors = parseInt(els.vectorColors.value) || 6;
  s.compressFormat = els.compressFormat.value;
  s.compressQuality = parseInt(els.compressQuality.value) || 90;
}

export function updateImgToolsSettingsUI() {
  const tool = state.imgTools.tool;
  els.imgToolsModeUpscale.classList.toggle('active', tool === 'upscale');
  els.imgToolsModeBgRemove.classList.toggle('active', tool === 'bgremove');
  els.imgToolsModeVector.classList.toggle('active', tool === 'vector');
  els.imgToolsModeCompress.classList.toggle('active', tool === 'compress');
  els.imgToolsSettingsUpscale.classList.toggle('hidden', tool !== 'upscale');
  els.imgToolsSettingsBgRemove.classList.toggle('hidden', tool !== 'bgremove');
  els.imgToolsSettingsVector.classList.toggle('hidden', tool !== 'vector');
  els.imgToolsSettingsCompress.classList.toggle('hidden', tool !== 'compress');

  els.upscaleAiModelField.classList.toggle('hidden', els.upscaleAlgorithm.value !== 'ai');
  els.vectorTraceOptions.classList.toggle('hidden', els.vectorMode.value !== 'trace');
  // Quality sliders only apply to lossy WebP output.
  els.upscaleQualityField.classList.toggle('hidden', els.upscaleFormat.value !== 'webp');
  els.compressQualityField.classList.toggle('hidden', els.compressFormat.value !== 'webp');
  els.bgremoveQualityField.classList.toggle('hidden', els.bgremoveFormat.value !== 'webp');

  // xBR only supports integer 2-4x; all current scale options are valid.
  updateImgToolsButtons();
}

function updateImgToolsButtons() {
  const activeFile = getActiveImgToolsFile();
  const busy = state.imgTools.isProcessing;
  els.btnImgToolsProcess.disabled = busy || !activeFile;
  els.btnImgToolsProcessAll.disabled = busy || state.imgTools.files.length === 0;
  els.btnImgToolsDownload.disabled = busy || !(activeFile && activeFile.result);
  const hasResults = state.imgTools.files.some(f => f.result);
  els.btnImgToolsDownloadAll.disabled = busy || !hasResults;
  els.btnImgToolsSaveFolder.disabled = busy || !hasResults || !state.imgTools.dirHandle;
  updateImgToolsExportSummary(activeFile, hasResults);
}

// Summary line shown above the export buttons in the right panel.
function updateImgToolsExportSummary(activeFile, hasResults) {
  if (!els.imgToolsExportSummary) return;
  const doneCount = state.imgTools.files.filter(f => f.result).length;
  const total = state.imgTools.files.length;
  if (activeFile && activeFile.result) {
    els.imgToolsExportSummary.innerHTML =
      `<strong>${activeFile.name}</strong><br>${activeFile.resultLabel || 'Ready to export.'}` +
      (total > 1 ? `<br>${doneCount} / ${total} images processed.` : '');
  } else if (hasResults) {
    els.imgToolsExportSummary.innerHTML = `${doneCount} / ${total} images processed. Select a processed image to download it individually.`;
  } else if (total > 0) {
    els.imgToolsExportSummary.textContent = 'Process an image to enable export.';
  } else {
    els.imgToolsExportSummary.textContent = 'Load and process an image to enable export.';
  }
}

// Decode a File into an imgTools fileObj (canvas-backed). relPath preserves
// subfolder structure when the source came from an opened folder.
function loadImgToolsFileObj(file, relPath) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve({
        id: `imgtool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        relPath: relPath || file.name,
        canvas,
        origBytes: file.size || 0,
        result: null,
        resultLabel: ''
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load ${file.name}`));
    };
    img.src = url;
  });
}

function handleImgToolsFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    showToast('Invalid Files', 'Please upload PNG, JPEG or WebP images.', 'warning');
    return;
  }

  files.forEach(async (file) => {
    try {
      const fileObj = await loadImgToolsFileObj(file);
      state.imgTools.files.push(fileObj);
      if (!state.imgTools.activeId) state.imgTools.activeId = fileObj.id;
      renderImgToolsFileList();
      renderImgToolsView();
    } catch (err) {
      showToast('Load Error', `Failed to load ${file.name}.`, 'error');
    }
  });
}

// Open a local folder, recursively scan for images, and queue them.
// Uses the File System Access API (Chrome/Edge). The handle is retained so
// results can be written straight back into a "_upscaled" subfolder.
async function handleImgToolsOpenFolder() {
  if (!window.showDirectoryPicker) {
    showToast('Not Supported', 'Folder access requires Chrome or Edge. Use Browse Files instead.', 'warning');
    return;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ id: 'spriteforge-imgtools', mode: 'readwrite' });
  } catch (err) {
    return; // user cancelled the picker
  }

  state.imgTools.dirHandle = dirHandle;
  showImgToolsLoading(true, `Scanning "${dirHandle.name}"...`);

  const imageRe = /\.(png|jpe?g|webp)$/i;
  const found = [];
  async function walk(handle, prefix) {
    for await (const entry of handle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (entry.name === '_upscaled') continue; // never re-ingest our own output
        await walk(entry, `${prefix}${entry.name}/`);
      } else if (entry.kind === 'file' && imageRe.test(entry.name)) {
        found.push({ entry, relPath: `${prefix}${entry.name}` });
      }
    }
  }

  let added = 0;
  try {
    await walk(dirHandle, '');
    for (const { entry, relPath } of found) {
      try {
        const file = await entry.getFile();
        const fileObj = await loadImgToolsFileObj(file, relPath);
        state.imgTools.files.push(fileObj);
        if (!state.imgTools.activeId) state.imgTools.activeId = fileObj.id;
        added++;
      } catch (err) {
        console.error(`Skipped ${relPath}:`, err);
      }
    }
  } finally {
    showImgToolsLoading(false);
    renderImgToolsFileList();
    renderImgToolsView();
    updateImgToolsFolderUI();
  }

  if (added > 0) {
    showToast('Folder Loaded', `Queued ${added} image${added !== 1 ? 's' : ''} from "${dirHandle.name}". Results save to its _upscaled subfolder.`, 'success');
  } else {
    showToast('No Images Found', `"${dirHandle.name}" has no PNG/JPEG/WebP images.`, 'warning');
  }
}

// Write every processed result back into <picked folder>/_upscaled, mirroring
// the original subfolder layout. Original files are never overwritten.
async function imgToolsSaveToFolder() {
  const dirHandle = state.imgTools.dirHandle;
  if (!dirHandle) {
    showToast('No Folder', 'Use "Open Folder" first to enable saving back.', 'warning');
    return;
  }
  const processed = state.imgTools.files.filter(f => f.result);
  if (processed.length === 0) {
    showToast('Nothing to Save', 'Process the images before saving.', 'warning');
    return;
  }

  if (dirHandle.queryPermission) {
    let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      showToast('Permission Denied', 'Write access to the folder was not granted.', 'error');
      return;
    }
  }

  state.imgTools.isProcessing = true;
  updateImgToolsButtons();
  showImgToolsLoading(true, 'Saving results to folder...');

  let saved = 0;
  let failed = 0;
  try {
    const outRoot = await dirHandle.getDirectoryHandle('_upscaled', { create: true });
    for (const fileObj of processed) {
      try {
        const parts = (fileObj.relPath || fileObj.name).split('/');
        parts.pop(); // drop filename; result filename is derived separately
        let outDir = outRoot;
        for (const part of parts) {
          outDir = await outDir.getDirectoryHandle(part, { create: true });
        }
        const outName = imgToolsResultFilename(fileObj);
        const fh = await outDir.getFileHandle(outName, { create: true });
        const writable = await fh.createWritable();
        {
          const blob = await imgToolsResultBlob(fileObj.result);
          await writable.write(blob);
        }
        await writable.close();
        saved++;
      } catch (err) {
        console.error(err);
        failed++;
      }
    }
  } catch (err) {
    console.error(err);
    showToast('Save Failed', err.message, 'error');
  } finally {
    state.imgTools.isProcessing = false;
    showImgToolsLoading(false);
    updateImgToolsButtons();
  }

  if (saved > 0) {
    showToast('Saved to Folder', `Wrote ${saved} file${saved !== 1 ? 's' : ''} to "${dirHandle.name}/_upscaled"${failed ? `. ${failed} failed.` : '.'}`, failed ? 'warning' : 'success');
  } else if (failed > 0) {
    showToast('Save Failed', `Could not write ${failed} file${failed !== 1 ? 's' : ''}.`, 'error');
  }
}

function updateImgToolsFolderUI() {
  const supported = !!window.showDirectoryPicker;
  els.btnImgToolsOpenFolder.classList.toggle('hidden', !supported);
  els.btnImgToolsSaveFolder.classList.toggle('hidden', !supported);
  if (!supported) return;

  const dir = state.imgTools.dirHandle;
  if (dir) {
    els.imgToolsFolderHint.classList.remove('hidden');
    els.imgToolsFolderHint.innerHTML = `📁 Linked to <b>${dir.name}</b> — results save to <b>${dir.name}/_upscaled</b>.`;
  } else {
    els.imgToolsFolderHint.classList.add('hidden');
  }
}

function renderImgToolsFileList() {
  els.imgToolsFileList.innerHTML = '';
  state.imgTools.files.forEach(fileObj => {
    const li = document.createElement('li');
    li.className = 'file-item' + (fileObj.id === state.imgTools.activeId ? ' active' : '');
    li.innerHTML = `
      <div class="file-info">
        <span class="file-name" title="${fileObj.name}">${fileObj.name}</span>
        <span class="file-meta">${fileObj.canvas.width}x${fileObj.canvas.height}px${fileObj.result ? ' • done' : ''}</span>
      </div>
      <button class="btn-icon-sm file-remove" title="Remove">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;
    li.addEventListener('click', () => {
      state.imgTools.activeId = fileObj.id;
      renderImgToolsFileList();
      renderImgToolsView();
    });
    li.querySelector('.file-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.imgTools.files = state.imgTools.files.filter(f => f.id !== fileObj.id);
      if (state.imgTools.activeId === fileObj.id) {
        state.imgTools.activeId = state.imgTools.files.length > 0 ? state.imgTools.files[0].id : null;
      }
      renderImgToolsFileList();
      renderImgToolsView();
    });
    els.imgToolsFileList.appendChild(li);
  });
  updateImgToolsButtons();
}

function showImgToolsLoading(show, text) {
  els.imgToolsLoadingOverlay.classList.toggle('hidden', !show);
  if (text) els.imgToolsLoadingText.textContent = text;
}


async function processImgToolsFile(fileObj) {
  syncImgToolsSettingsFromUI();
  const s = state.imgTools.settings;
  const onProgress = ({ label }) => showImgToolsLoading(true, `${fileObj.name}: ${label}`);

  if (state.imgTools.tool === 'compress') {
    // Pure re-encode of the source pixels — no resize. The win is format (WebP).
    const fmt = s.compressFormat;
    const blob = await encodeCanvasToBlob(fileObj.canvas, fmt, s.compressQuality);
    const orig = fileObj.origBytes || 0;
    const delta = orig ? Math.round((1 - blob.size / orig) * 100) : null;
    fileObj.result = { type: 'raster', canvas: fileObj.canvas, format: fmt, quality: s.compressQuality, blob, bytes: blob.size };
    const qLabel = fmt === 'webp' ? ` q${s.compressQuality}` : '';
    const deltaLabel = delta != null ? ` (${delta >= 0 ? '−' : '+'}${Math.abs(delta)}% from ${formatBytes(orig)})` : '';
    fileObj.resultLabel = `${fmt.toUpperCase()}${qLabel} • ${formatBytes(blob.size)}${deltaLabel}`;
    fileObj.resultSuffix = `_${fmt}`;
  } else if (state.imgTools.tool === 'upscale') {
    const resultCanvas = await upscaleImage(fileObj.canvas, {
      algorithm: s.upscaleAlgorithm,
      scale: s.upscaleScale,
      aiModel: s.upscaleAiModel,
      onProgress
    });
    const backend = s.upscaleAlgorithm === 'ai' && getAiBackend() === 'webgpu' ? ' · WebGPU' : s.upscaleAlgorithm === 'ai' ? ' · CPU' : '';
    const algoLabels = { ai: `AI (${AI_MODELS[s.upscaleAiModel]?.label || s.upscaleAiModel})`, xbr: 'xBR', smooth: 'MKS2013', nearest: 'Nearest' };
    const fmt = s.upscaleFormat;
    const blob = await encodeCanvasToBlob(resultCanvas, fmt, s.upscaleQuality);
    const qLabel = fmt === 'webp' ? ` q${s.upscaleQuality}` : '';
    fileObj.result = { type: 'raster', canvas: resultCanvas, format: fmt, quality: s.upscaleQuality, blob, bytes: blob.size };
    fileObj.resultLabel = `${algoLabels[s.upscaleAlgorithm] || s.upscaleAlgorithm} ${s.upscaleScale}x → ${resultCanvas.width}x${resultCanvas.height}px · ${fmt.toUpperCase()}${qLabel} ${formatBytes(blob.size)}${backend}`;
    fileObj.resultSuffix = `_${s.upscaleAlgorithm}_x${s.upscaleScale}`;
  } else if (state.imgTools.tool === 'bgremove') {
    await processImgToolsBgRemoval(fileObj, s, onProgress);
  } else {
    const svg = await vectorizeImage(fileObj.canvas, {
      mode: s.vectorMode,
      preset: s.vectorPreset,
      colors: s.vectorColors,
      onProgress
    });
    const kb = (new Blob([svg]).size / 1024).toFixed(1);
    fileObj.result = { type: 'svg', svg };
    fileObj.resultLabel = `SVG ${s.vectorMode === 'pixel' ? 'Pixel Perfect' : `Trace (${s.vectorPreset})`} • ${kb} KB`;
    fileObj.resultSuffix = `_${s.vectorMode === 'pixel' ? 'pixel' : 'trace'}`;
  }
}

// ----------------------------------------------------
// Image Tools: AI Background Removal + Brush Refinement
// ----------------------------------------------------
// The AI (imgly ISNet, fully local) produces an alpha mask. The result is
// always composed as: original pixels × mask alpha. Brush strokes edit the
// mask only (erase = punch alpha out, restore = paint alpha back), so
// restoring always brings back the untouched original pixels — Canva-style.

const BG_MODEL_LABELS = { isnet: 'Best', isnet_fp16: 'Standard', isnet_quint8: 'Fast' };
const BG_UNDO_LIMIT = 30;

// Resolved once per session: 'gpu' when WebGPU inference works, else 'cpu'.
let bgRemovalDevice = null;

async function runImglyRemoveBackground(srcCanvas, model, onAssetProgress) {
  const { removeBackground } = await import('@imgly/background-removal');
  const srcBlob = await new Promise(r => srcCanvas.toBlob(r, 'image/png'));
  const baseCfg = {
    model,
    publicPath: new URL('resources/', window.location.href).href,
    progress: onAssetProgress
  };
  const devices = bgRemovalDevice ? [bgRemovalDevice] : (navigator.gpu ? ['gpu', 'cpu'] : ['cpu']);
  let lastErr;
  for (const device of devices) {
    try {
      const blob = await removeBackground(srcBlob, { ...baseCfg, device });
      bgRemovalDevice = device;
      return blob;
    } catch (err) {
      lastErr = err;
      console.warn(`BG removal on '${device}' failed${device !== devices[devices.length - 1] ? ', falling back' : ''}:`, err);
    }
  }
  throw lastErr;
}

async function processImgToolsBgRemoval(fileObj, s, onProgress) {
  const model = s.bgModel;
  // The raw AI mask is cached per file+model; reprocessing only re-runs
  // inference when the model changed. Brush edits always start fresh.
  if (!fileObj.bgAiMask || fileObj.bgAiModel !== model) {
    onProgress({ label: 'Removing background (AI, local)...' });

    // Serialize with slicer/video AI removal to avoid concurrent model runs.
    const myTurn = new Promise((resolve) => { processingQueue.current.then(resolve); });
    let releaseQueue;
    processingQueue.current = new Promise((resolve) => { releaseQueue = resolve; });
    await myTurn;

    try {
      if (isSegModel(model)) {
        // Advanced ONNX segmenter (ISNet-Anime / ToonOut / BiRefNet / RMBG),
        // downloaded once from Hugging Face and cached locally.
        const { mask, backend } = await segmentBackground(fileObj.canvas, model, ({ label }) => {
          showImgToolsLoading(true, `${fileObj.name}: ${label}`);
        });
        fileObj.bgAiMask = mask;
        fileObj.bgAiDevice = backend === 'webgpu' ? 'WebGPU' : 'CPU';
      } else {
        // Bundled imgly ISNet pipeline (works fully offline).
        const blob = await runImglyRemoveBackground(fileObj.canvas, model, (key, current, total) => {
          const pct = total ? Math.round((current / total) * 100) : 0;
          showImgToolsLoading(true, `${fileObj.name}: loading AI model (${key}) ${pct}%`);
        });
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
        URL.revokeObjectURL(img.src);

        const mask = document.createElement('canvas');
        mask.width = fileObj.canvas.width;
        mask.height = fileObj.canvas.height;
        mask.getContext('2d').drawImage(img, 0, 0, mask.width, mask.height);
        fileObj.bgAiMask = mask;
        fileObj.bgAiDevice = bgRemovalDevice === 'gpu' ? 'WebGPU' : 'CPU';
      }
      fileObj.bgAiModel = model;
    } finally {
      releaseQueue();
    }
  }

  // Working mask = editable copy of the AI mask; history starts clean.
  const work = document.createElement('canvas');
  work.width = fileObj.bgAiMask.width;
  work.height = fileObj.bgAiMask.height;
  work.getContext('2d').drawImage(fileObj.bgAiMask, 0, 0);
  fileObj.bgMask = work;
  fileObj.bgUndo = [];
  fileObj.bgRedo = [];

  fileObj.result = {
    type: 'raster',
    canvas: document.createElement('canvas'),
    format: s.bgFormat,
    quality: s.bgQuality,
    bgEditable: true
  };
  composeBgRemovalResult(fileObj);
  await refreshBgResultBlob(fileObj);
  fileObj.resultSuffix = '_nobg';
}

// Re-derive the result canvas from original pixels × current mask alpha.
function composeBgRemovalResult(fileObj) {
  const src = fileObj.canvas;
  const out = fileObj.result.canvas;
  out.width = src.width;
  out.height = src.height;
  const c = out.getContext('2d');
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(fileObj.bgMask, 0, 0);
  c.globalCompositeOperation = 'source-over';
}

async function refreshBgResultBlob(fileObj) {
  const r = fileObj.result;
  const blob = await encodeCanvasToBlob(r.canvas, r.format, r.quality);
  r.blob = blob;
  r.bytes = blob.size;
  const modelLabel = BG_SEG_MODELS[fileObj.bgAiModel]?.shortLabel
    || BG_MODEL_LABELS[fileObj.bgAiModel]
    || fileObj.bgAiModel;
  const device = fileObj.bgAiDevice || (bgRemovalDevice === 'gpu' ? 'WebGPU' : 'CPU');
  const qLabel = r.format === 'webp' ? ` q${r.quality}` : '';
  const edited = (fileObj.bgUndo && fileObj.bgUndo.length > 0) ? ' · brush edited' : '';
  fileObj.resultLabel = `BG Removed (${modelLabel} · ${device})${edited} · ${r.format.toUpperCase()}${qLabel} ${formatBytes(blob.size)}`;
}

// True when the active file's result can be brush-edited right now.
function bgBrushActive() {
  const f = getActiveImgToolsFile();
  return !!(state.imgTools.tool === 'bgremove' && f && f.result && f.result.bgEditable && f.bgMask);
}

function copyMaskCanvas(mask) {
  const snap = document.createElement('canvas');
  snap.width = mask.width;
  snap.height = mask.height;
  snap.getContext('2d').drawImage(mask, 0, 0);
  return snap;
}

// Snapshot the mask before a stroke so it can be undone.
function bgBrushSnapshot(fileObj) {
  fileObj.bgUndo.push(copyMaskCanvas(fileObj.bgMask));
  if (fileObj.bgUndo.length > BG_UNDO_LIMIT) fileObj.bgUndo.shift();
  fileObj.bgRedo = [];
}

function bgBrushStroke(fileObj, x0, y0, x1, y1) {
  const c = fileObj.bgMask.getContext('2d');
  const erase = state.imgTools.brush.mode === 'erase';
  c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  c.strokeStyle = '#fff';
  c.lineWidth = state.imgTools.brush.size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x0, y0);
  // A zero-length path draws nothing; nudge so a click stamps a dot.
  c.lineTo(x1 + (x1 === x0 && y1 === y0 ? 0.01 : 0), y1);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  composeBgRemovalResult(fileObj);
}

function bgBrushUndo() {
  const f = getActiveImgToolsFile();
  if (!bgBrushActive() || f.bgUndo.length === 0) return;
  f.bgRedo.push(f.bgMask);
  f.bgMask = f.bgUndo.pop();
  bgBrushAfterEdit(f);
}

function bgBrushRedo() {
  const f = getActiveImgToolsFile();
  if (!bgBrushActive() || f.bgRedo.length === 0) return;
  f.bgUndo.push(f.bgMask);
  f.bgMask = f.bgRedo.pop();
  bgBrushAfterEdit(f);
}

function bgBrushReset() {
  const f = getActiveImgToolsFile();
  if (!bgBrushActive() || !f.bgAiMask) return;
  bgBrushSnapshot(f);
  f.bgMask = copyMaskCanvas(f.bgAiMask);
  bgBrushAfterEdit(f);
}

function bgBrushAfterEdit(fileObj) {
  composeBgRemovalResult(fileObj);
  redrawBgResultView(fileObj);
  scheduleBgBlobRefresh(fileObj);
  updateBrushToolbar();
}

// The live <canvas> element showing the result in the compare pane.
let bgResultViewCanvas = null;

function redrawBgResultView(fileObj) {
  if (!bgResultViewCanvas) return;
  const c = bgResultViewCanvas.getContext('2d');
  c.clearRect(0, 0, bgResultViewCanvas.width, bgResultViewCanvas.height);
  c.drawImage(fileObj.result.canvas, 0, 0);
}

// Debounced re-encode after brush edits keeps download/export in sync
// without paying the PNG encode cost on every stroke.
let bgBlobRefreshTimer = null;
function scheduleBgBlobRefresh(fileObj) {
  clearTimeout(bgBlobRefreshTimer);
  bgBlobRefreshTimer = setTimeout(async () => {
    await refreshBgResultBlob(fileObj);
    if (getActiveImgToolsFile() === fileObj) {
      els.imgToolsResultMeta.textContent = fileObj.resultLabel;
      updateImgToolsButtons();
    }
  }, 300);
}

function updateBrushToolbar() {
  const active = bgBrushActive();
  els.imgToolsBrushToolbar.classList.toggle('hidden', !active);
  if (!active) {
    els.imgToolsBrushCursor.classList.add('hidden');
    return;
  }
  const f = getActiveImgToolsFile();
  els.imgToolsBrushErase.classList.toggle('active', state.imgTools.brush.mode === 'erase');
  els.imgToolsBrushRestore.classList.toggle('active', state.imgTools.brush.mode === 'restore');
  els.btnImgToolsBrushUndo.disabled = f.bgUndo.length === 0;
  els.btnImgToolsBrushRedo.disabled = f.bgRedo.length === 0;
}

function attachBgBrushEvents(view, fileObj) {
  let drawing = false;
  let last = null;

  const toMaskCoords = (e) => {
    const rect = view.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (view.width / rect.width),
      y: (e.clientY - rect.top) * (view.height / rect.height)
    };
  };

  const moveCursor = (e) => {
    const rect = view.getBoundingClientRect();
    const d = state.imgTools.brush.size * (rect.width / view.width);
    const cur = els.imgToolsBrushCursor;
    cur.style.width = `${d}px`;
    cur.style.height = `${d}px`;
    cur.style.left = `${e.clientX - d / 2}px`;
    cur.style.top = `${e.clientY - d / 2}px`;
    cur.classList.toggle('restore', state.imgTools.brush.mode === 'restore');
    cur.classList.remove('hidden');
  };

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    view.setPointerCapture(e.pointerId);
    drawing = true;
    bgBrushSnapshot(fileObj);
    last = toMaskCoords(e);
    bgBrushStroke(fileObj, last.x, last.y, last.x, last.y);
    redrawBgResultView(fileObj);
    updateBrushToolbar();
  });
  view.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (!drawing) return;
    const p = toMaskCoords(e);
    bgBrushStroke(fileObj, last.x, last.y, p.x, p.y);
    last = p;
    redrawBgResultView(fileObj);
  });
  const endStroke = () => {
    if (!drawing) return;
    drawing = false;
    scheduleBgBlobRefresh(fileObj);
  };
  view.addEventListener('pointerup', endStroke);
  view.addEventListener('pointercancel', endStroke);
  view.addEventListener('pointerleave', () => {
    if (!drawing) els.imgToolsBrushCursor.classList.add('hidden');
  });
}

async function imgToolsProcess(filesToProcess) {
  if (state.imgTools.isProcessing || filesToProcess.length === 0) return;
  state.imgTools.isProcessing = true;
  updateImgToolsButtons();

  let failed = 0;
  try {
    for (let i = 0; i < filesToProcess.length; i++) {
      const fileObj = filesToProcess[i];
      showImgToolsLoading(true, `Processing ${fileObj.name} (${i + 1}/${filesToProcess.length})...`);
      // Give the overlay a frame to paint before heavy synchronous work.
      await new Promise(r => setTimeout(r, 30));
      try {
        await processImgToolsFile(fileObj);
      } catch (err) {
        console.error(err);
        failed++;
        showToast('Processing Failed', `${fileObj.name}: ${err.message}`, 'error');
      }
    }
  } finally {
    state.imgTools.isProcessing = false;
    showImgToolsLoading(false);
    renderImgToolsFileList();
    renderImgToolsView();
  }

  const succeeded = filesToProcess.length - failed;
  if (succeeded > 0) {
    showToast('Processing Complete', `Processed ${succeeded} image${succeeded > 1 ? 's' : ''}.`, 'success');
  }
}

export function renderImgToolsView() {
  const activeFile = getActiveImgToolsFile();
  const zoom = state.imgTools.zoom;

  // Original pane
  els.imgToolsPaneOriginal.innerHTML = '';
  els.imgToolsPaneResult.innerHTML = '';
  bgResultViewCanvas = null;

  if (!activeFile) {
    updateBrushToolbar();
    els.imgToolsPaneOriginal.innerHTML = '<div class="no-sprites-msg" style="border: none; background: transparent; padding: 60px 20px;">Load an image to begin.</div>';
    els.imgToolsPaneResult.innerHTML = '<div class="no-sprites-msg" style="border: none; background: transparent; padding: 60px 20px;">Process the image to see the result.</div>';
    els.imgToolsInfo.textContent = 'No image loaded';
    els.imgToolsResultMeta.textContent = '';
    updateImgToolsButtons();
    return;
  }

  const displayW = Math.max(1, Math.round(activeFile.canvas.width * zoom));

  const wrapEl = (el) => {
    el.style.display = 'block';
    el.style.margin = '16px';
    el.style.width = `${displayW}px`;
    el.style.height = 'auto';
    if (zoom >= 3) el.style.imageRendering = 'pixelated';
    return el;
  };

  // Original: draw source canvas into a display canvas (cheap, reuses bitmap)
  const origView = document.createElement('canvas');
  origView.width = activeFile.canvas.width;
  origView.height = activeFile.canvas.height;
  origView.getContext('2d').drawImage(activeFile.canvas, 0, 0);
  els.imgToolsPaneOriginal.appendChild(wrapEl(origView));

  // Result pane
  if (activeFile.result) {
    if (activeFile.result.type !== 'svg') {
      const resView = document.createElement('canvas');
      resView.width = activeFile.result.canvas.width;
      resView.height = activeFile.result.canvas.height;
      resView.getContext('2d').drawImage(activeFile.result.canvas, 0, 0);
      els.imgToolsPaneResult.appendChild(wrapEl(resView));
      bgResultViewCanvas = resView;
      if (state.imgTools.tool === 'bgremove' && activeFile.result.bgEditable && activeFile.bgMask) {
        resView.classList.add('bg-brush-target');
        attachBgBrushEvents(resView, activeFile);
      }
    } else {
      const img = document.createElement('img');
      img.src = svgToDataUrl(activeFile.result.svg);
      els.imgToolsPaneResult.appendChild(wrapEl(img));
    }
    els.imgToolsResultMeta.textContent = activeFile.resultLabel;
  } else {
    els.imgToolsPaneResult.innerHTML = '<div class="no-sprites-msg" style="border: none; background: transparent; padding: 60px 20px;">Process the image to see the result.</div>';
    els.imgToolsResultMeta.textContent = '';
  }

  els.imgToolsInfo.textContent = `${activeFile.name} (${activeFile.canvas.width}x${activeFile.canvas.height}px)`;
  els.imgToolsZoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  updateBrushToolbar();
  updateImgToolsButtons();
}

function setImgToolsZoom(level) {
  state.imgTools.zoom = Math.max(0.1, Math.min(16, level));
  renderImgToolsView();
}

function imgToolsZoomToFit() {
  const activeFile = getActiveImgToolsFile();
  if (!activeFile) return;
  const paneW = els.imgToolsPaneOriginal.clientWidth - 32;
  const paneH = els.imgToolsPaneOriginal.clientHeight - 32;
  if (paneW <= 0 || paneH <= 0) return;
  const scale = Math.min(paneW / activeFile.canvas.width, paneH / activeFile.canvas.height);
  setImgToolsZoom(scale);
}


function imgToolsResultFilename(fileObj) {
  const base = fileObj.name.substring(0, fileObj.name.lastIndexOf('.')) || fileObj.name;
  const r = fileObj.result;
  const ext = r.type === 'svg' ? 'svg' : (r.format || 'png');
  return `${base}${fileObj.resultSuffix || ''}.${ext}`;
}

/** Returns the encoded Blob for a result, reusing the one computed at process time. */
async function imgToolsResultBlob(result) {
  if (result.type === 'svg') return new Blob([result.svg], { type: 'image/svg+xml' });
  if (result.blob) return result.blob;
  return encodeCanvasToBlob(result.canvas, result.format || 'png', result.quality);
}

async function imgToolsDownloadCurrent() {
  const activeFile = getActiveImgToolsFile();
  if (!activeFile || !activeFile.result) return;
  const blob = await imgToolsResultBlob(activeFile.result);
  downloadBlob(blob, imgToolsResultFilename(activeFile));
}

async function imgToolsDownloadAll() {
  const processed = state.imgTools.files.filter(f => f.result);
  if (processed.length === 0) return;

  try {
    const zip = new JSZip();
    for (const fileObj of processed) {
      const blob = await imgToolsResultBlob(fileObj.result);
      zip.file(imgToolsResultFilename(fileObj), blob);
    }
    const content = await zip.generateAsync({ type: 'blob' });
    downloadBlob(content, 'SpriteForge_ImageTools_Export.zip');
    showToast('Export Complete', `Exported ${processed.length} result${processed.length > 1 ? 's' : ''} as ZIP.`, 'success');
  } catch (err) {
    console.error(err);
    showToast('Export Failed', err.message, 'error');
  }
}

export function bindImgToolsEvents() {

  // Dropzone
  els.imgToolsDropzone.addEventListener('click', () => els.imgToolsFileInput.click());
  els.imgToolsFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleImgToolsFiles(e.target.files);
    els.imgToolsFileInput.value = '';
  });
  els.imgToolsDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.imgToolsDropzone.classList.add('dragover');
  });
  els.imgToolsDropzone.addEventListener('dragleave', () => {
    els.imgToolsDropzone.classList.remove('dragover');
  });
  els.imgToolsDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.imgToolsDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleImgToolsFiles(e.dataTransfer.files);
  });

  // Tool switch (re-render so the brush toolbar/handlers follow the tool)
  const setImgTool = (tool) => {
    state.imgTools.tool = tool;
    updateImgToolsSettingsUI();
    renderImgToolsView();
  };
  els.imgToolsModeUpscale.addEventListener('click', () => setImgTool('upscale'));
  els.imgToolsModeBgRemove.addEventListener('click', () => setImgTool('bgremove'));
  els.imgToolsModeVector.addEventListener('click', () => setImgTool('vector'));
  els.imgToolsModeCompress.addEventListener('click', () => setImgTool('compress'));

  // Settings
  els.upscaleAlgorithm.addEventListener('change', updateImgToolsSettingsUI);
  els.upscaleFormat.addEventListener('change', updateImgToolsSettingsUI);
  els.compressFormat.addEventListener('change', updateImgToolsSettingsUI);
  els.upscaleQuality.addEventListener('input', (e) => {
    els.labelUpscaleQuality.textContent = `WebP Quality (${e.target.value})`;
  });
  els.compressQuality.addEventListener('input', (e) => {
    els.labelCompressQuality.textContent = `WebP Quality (${e.target.value})`;
  });
  els.vectorMode.addEventListener('change', updateImgToolsSettingsUI);
  els.vectorColors.addEventListener('input', (e) => {
    els.labelVectorColors.textContent = `Color Detail (${e.target.value}/8)`;
  });
  els.bgremoveFormat.addEventListener('change', updateImgToolsSettingsUI);
  els.bgremoveQuality.addEventListener('input', (e) => {
    els.labelBgremoveQuality.textContent = `WebP Quality (${e.target.value})`;
  });

  // BG-removal brush refinement toolbar
  els.imgToolsBrushErase.addEventListener('click', () => {
    state.imgTools.brush.mode = 'erase';
    updateBrushToolbar();
  });
  els.imgToolsBrushRestore.addEventListener('click', () => {
    state.imgTools.brush.mode = 'restore';
    updateBrushToolbar();
  });
  els.imgToolsBrushSize.addEventListener('input', (e) => {
    state.imgTools.brush.size = parseInt(e.target.value) || 40;
    els.imgToolsBrushSizeLabel.textContent = e.target.value;
  });
  els.btnImgToolsBrushUndo.addEventListener('click', bgBrushUndo);
  els.btnImgToolsBrushRedo.addEventListener('click', bgBrushRedo);
  els.btnImgToolsBrushReset.addEventListener('click', bgBrushReset);

  // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) for brush strokes, scoped to the
  // Image Tools workspace with an editable BG-removal result.
  document.addEventListener('keydown', (e) => {
    if (state.workspaceMode !== 'imgtools' || !bgBrushActive()) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      bgBrushUndo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      bgBrushRedo();
    }
  });

  // Process actions
  els.btnImgToolsProcess.addEventListener('click', () => {
    const activeFile = getActiveImgToolsFile();
    if (activeFile) imgToolsProcess([activeFile]);
  });
  els.btnImgToolsProcessAll.addEventListener('click', () => {
    imgToolsProcess([...state.imgTools.files]);
  });

  // Folder access (File System Access API — Chrome/Edge)
  els.btnImgToolsOpenFolder.addEventListener('click', handleImgToolsOpenFolder);
  els.btnImgToolsSaveFolder.addEventListener('click', imgToolsSaveToFolder);
  updateImgToolsFolderUI();

  // Export actions
  els.btnImgToolsDownload.addEventListener('click', imgToolsDownloadCurrent);
  els.btnImgToolsDownloadAll.addEventListener('click', imgToolsDownloadAll);

  // Zoom controls
  els.btnImgToolsZoomIn.addEventListener('click', () => setImgToolsZoom(state.imgTools.zoom * 1.25));
  els.btnImgToolsZoomOut.addEventListener('click', () => setImgToolsZoom(state.imgTools.zoom / 1.25));
  els.btnImgToolsZoomReset.addEventListener('click', () => setImgToolsZoom(1.0));
  els.btnImgToolsZoomFit.addEventListener('click', imgToolsZoomToFit);

  // Synchronized scrolling between compare panes
  let syncingScroll = false;
  const syncScroll = (from, to) => {
    from.addEventListener('scroll', () => {
      if (syncingScroll) return;
      syncingScroll = true;
      to.scrollLeft = from.scrollLeft;
      to.scrollTop = from.scrollTop;
      requestAnimationFrame(() => { syncingScroll = false; });
    });
  };
  syncScroll(els.imgToolsPaneOriginal, els.imgToolsPaneResult);
  syncScroll(els.imgToolsPaneResult, els.imgToolsPaneOriginal);
}
