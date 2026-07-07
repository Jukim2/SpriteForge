import JSZip from 'jszip';
import { state, getActiveFile } from '../app/state.js';
import { els } from '../app/dom.js';
import { showToast, showProgressBar, updateProgressBar } from '../app/ui.js';

export function updateExportStats() {
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

async function exportActiveFileIndividual() {
  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Exporting individual frames...', 0);

  try {
    const template = activeFile.settings.namingTemplate;

    for (let i = 0; i < enabledSlices.length; i++) {
      const slice = enabledSlices[i];
      const blob = await getSliceBlob(activeFile, slice);
      const outputName = `${getFileName(template, slice.row, slice.col, slice.id + 1, activeFile.name)}.png`;
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = outputName;
      link.click();
      
      // Short delay to let browser handle multiple downloads
      await new Promise(r => setTimeout(r, 150));

      const percent = Math.round(((i + 1) / enabledSlices.length) * 100);
      updateProgressBar(`Exported frame ${i+1}/${enabledSlices.length}`, percent);
    }

    showToast('Success', `Exported ${enabledSlices.length} sprites for ${activeFile.name} individually!`, 'success');
  } catch (err) {
    console.error(err);
    showToast('Export Failed', 'An error occurred during export.', 'error');
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

export function bindExportEvents() {
  els.btnExportActive.addEventListener('click', exportActiveFileIndividual);
  els.btnExportAllBatch.addEventListener('click', exportBatchZip);
}
