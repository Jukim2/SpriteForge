import { els } from './dom.js';

// ----------------------------------------------------
// UI Progress Overlay & Toast Notifications
// ----------------------------------------------------

// Called whenever the progress bar hides. Wired to updateExportStats in
// main.js init() — a registration seam so this module stays a leaf.
let onProgressHidden = () => {};
export function setOnProgressHidden(fn) { onProgressHidden = fn; }

export function showProgressBar(show) {
  if (show) {
    els.exportProgressContainer.classList.remove('hidden');
    // Disable primary action buttons during export
    els.btnExportActive.disabled = true;
    els.btnExportAllBatch.disabled = true;
  } else {
    els.exportProgressContainer.classList.add('hidden');
    onProgressHidden();
  }
}

export function updateProgressBar(text, percent) {
  els.progressStatusText.textContent = text;
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
}

export function showToast(title, message, type = 'info') {
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
