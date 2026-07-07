// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { state, getActiveFile } from '../../app/state.js';
import { els } from '../../app/dom.js';
import { showToast } from '../../app/ui.js';
import { switchWorkspaceMode } from '../../app/workspace.js';
import { updateExportStats } from '../exporter.js';
import { loadVideoFile } from '../video.js';
import { updateSettingsUI } from './settings.js';
import { processImageBackground, sliceFile, refreshActiveFileView, clearCanvas } from './process.js';
import { renderPreviews } from './previews.js';
import { zoomToFit } from './canvas.js';

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

export function bindSlicerFileEvents() {
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
}
