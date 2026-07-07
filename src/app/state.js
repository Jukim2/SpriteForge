// Application State
export const state = {
  files: [],         // Array of { id, file, name, size, imgElement, slices, settings, processedCanvas }
  activeFileId: null,
  zoom: 1.0,
  pan: { x: 0, y: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  hoveredSliceId: null,
  isPickingColor: false, // Flag for canvas color sampler
  activeSettings: {
    mode: 'grid',       // 'grid' or 'auto'
    gridW: 32,
    gridH: 32,
    autoMinW: 8,
    autoMinH: 8,
    autoTolerance: 5,
    autoRowGap: 12,
    autoMergeGap: 0,
    skipEmpty: true,
    namingTemplate: 'sprite_{row}_{col}',
    enableBgRemoval: false,
    bgRemovalMethod: 'chromakey', // 'chromakey' or 'ai'
    bgRemovalModelSize: 'medium', // 'small' | 'medium' | 'large'
    bgColor: '#00ff00',
    bgTolerance: 15,
    bgContiguous: true,
    // Custom Grid settings
    customRegion: null,    // { x, y, width, height }
    customCols: 3,
    customRows: 3,
    customColLines: [],    // x-coords of vertical dividers
    customRowLines: [],    // y-coords of horizontal dividers
    // Rematch settings
    rematchEnabled: false,
    rematchMode: 'largest', // 'largest' | 'custom'
    rematchWidth: 64,
    rematchHeight: 64,
    rematchFit: 'contain'  // 'contain' | 'cover' | 'stretch'
  },
  anim: {
    isPlaying: false,
    fps: 10,
    currentFrame: 0,
    timer: null,
    activeTab: 'slices'
  },
  workspaceMode: 'slicer',
  // Custom Grid interaction state
  customGrid: {
    isSelectingRegion: false,
    regionDragStart: null,      // { x, y } canvas coords where drag started
    regionDragCurrent: null,    // { x, y } current drag position
    isDraggingGuideline: false,
    dragGuidelineType: null,    // 'col' or 'row'
    dragGuidelineIndex: null,   // index in colLines/rowLines
    hoveredGuideline: null,     // { type: 'col'|'row', index }
    isDraggingRegion: false,
    regionDragMode: null,       // 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
    regionDragOffset: null      // { x, y }
  },
  video: {
    file: null,
    url: null,
    duration: 0,
    interval: 0.2,
    startRange: 0.0,
    endRange: 0.0,
    enableBgRemoval: false,
    bgRemovalMethod: 'chromakey', // 'chromakey' or 'ai'
    bgRemovalModelSize: 'medium', // 'small' | 'medium' | 'large'
    bgColor: '#00ff00',
    bgTolerance: 15,
    bgContiguous: true,
    frames: [] // Array of { index, time, canvas, processedCanvas, enabled }
  },
  imgTools: {
    files: [],       // Array of { id, name, relPath, canvas, result: {type, canvas?, svg?}, resultLabel }
    activeId: null,
    dirHandle: null, // FileSystemDirectoryHandle when a folder was opened (Chrome/Edge)
    zoom: 1.0,
    tool: 'upscale', // 'upscale' | 'bgremove' | 'vector' | 'compress'
    isProcessing: false,
    brush: {
      mode: 'erase', // 'erase' | 'restore'
      size: 40       // brush diameter in image pixels
    },
    settings: {
      upscaleAlgorithm: 'ai',   // 'ai' | 'xbr' | 'smooth' | 'nearest'
      upscaleAiModel: 'anime-best', // AI_MODELS key ('*-best' = full RRDBNet, others = compact)
      upscaleScale: 4,
      upscaleFormat: 'png',     // output encoding for upscale result: 'png' | 'webp'
      upscaleQuality: 90,       // webp quality 1-100 (ignored for png)
      bgModel: 'isnet_fp16',    // imgly ISNet variant: 'isnet' | 'isnet_fp16' | 'isnet_quint8'
      bgFormat: 'png',          // bg-removal output: 'png' | 'webp' (both keep alpha)
      bgQuality: 90,            // webp quality 1-100 (ignored for png)
      vectorMode: 'pixel',      // 'pixel' | 'trace'
      vectorPreset: 'balanced',
      vectorColors: 6, // vtracer per-channel color precision (1-8)
      compressFormat: 'webp',   // compress tool output: 'webp' | 'png'
      compressQuality: 90       // webp quality 1-100
    }
  }
};

export function getActiveFile() {
  return state.files.find(f => f.id === state.activeFileId);
}

// Shared mutex serializing AI model runs across slicer/video/imgTools
// (concurrent model executions cause WebGL context issues). Holder object
// because ESM imported bindings are read-only; consumers reassign `.current`.
export const processingQueue = { current: Promise.resolve() };
