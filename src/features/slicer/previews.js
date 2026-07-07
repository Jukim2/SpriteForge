// NOTE: slicer/ modules form intentional import cycles (settings <-> process
// <-> canvas <-> customGrid <-> previews). Safe in ESM because every module
// top level only declares functions; cross-module calls happen at event time.
import { state, getActiveFile } from '../../app/state.js';
import { els } from '../../app/dom.js';
import { updateExportStats } from '../exporter.js';
import { updateAnimationPlayer } from '../animPlayer.js';
import { drawCanvas } from './canvas.js';

// ----------------------------------------------------
// Preview Generation & List Rendering
// ----------------------------------------------------
export function renderPreviews() {
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

export function bindPreviewEvents() {
  els.btnToggleAllSlices.addEventListener('click', toggleAllSlices);
}
