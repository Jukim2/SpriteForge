// Application entry point. All feature logic lives in app/ (shared leaf
// modules + workspace switching) and features/ (slicer, video, animation
// player, exporter, image tools). This file only wires event bindings and
// kicks off the initial UI state.
import { setOnProgressHidden } from './app/ui.js';
import { bindWorkspaceEvents, switchWorkspaceMode } from './app/workspace.js';
import { bindSlicerFileEvents } from './features/slicer/files.js';
import { bindSlicerSettingsEvents, syncSettingsFromUI } from './features/slicer/settings.js';
import { bindCanvasEvents } from './features/slicer/canvas.js';
import { bindPreviewEvents } from './features/slicer/previews.js';
import { bindExportEvents, updateExportStats } from './features/exporter.js';
import { bindAnimEvents } from './features/animPlayer.js';
import { bindVideoEvents } from './features/video.js';
import { bindImgToolsEvents, updateImgToolsSettingsUI } from './features/imgtools.js';

// Initialize App
function init() {
  // Bind order mirrors the original monolithic bindEvents() so listener
  // registration order on shared targets is preserved.
  bindSlicerFileEvents();
  bindSlicerSettingsEvents();
  bindCanvasEvents();
  bindPreviewEvents();
  bindExportEvents();
  bindAnimEvents();
  bindWorkspaceEvents();
  bindVideoEvents();
  bindImgToolsEvents();

  setOnProgressHidden(updateExportStats);
  syncSettingsFromUI();
  updateExportStats();
  updateImgToolsSettingsUI();
  switchWorkspaceMode('slicer'); // Initialize UI layout states
}

// Start the Application
window.addEventListener('DOMContentLoaded', init);
