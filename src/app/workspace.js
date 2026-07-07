import { state } from './state.js';
import { els } from './dom.js';
import { switchPreviewTab, stopAnimPlayback, updateAnimationPlayer } from '../features/animPlayer.js';
import { renderImgToolsView } from '../features/imgtools.js';
import { drawCanvas } from '../features/slicer/canvas.js';
import { renderPreviews } from '../features/slicer/previews.js';

// ----------------------------------------------------
// Workspace Switcher & Video Operations
// ----------------------------------------------------
export function switchWorkspaceMode(mode) {
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

export function bindWorkspaceEvents() {
  els.wsBtnSlicer.addEventListener('click', () => switchWorkspaceMode('slicer'));
  els.wsBtnVideo.addEventListener('click', () => switchWorkspaceMode('video'));
  els.wsBtnImgTools.addEventListener('click', () => switchWorkspaceMode('imgtools'));
}
