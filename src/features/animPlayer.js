import gifshot from 'gifshot';
import { state, getActiveFile } from '../app/state.js';
import { els } from '../app/dom.js';
import { showToast, showProgressBar, updateProgressBar } from '../app/ui.js';


// ----------------------------------------------------
// Preview Tab Switching & Animation Playback
// ----------------------------------------------------
export function switchPreviewTab(tab) {
  state.anim.activeTab = tab;

  if (tab === 'slices') {
    els.tabSlices.classList.add('active');
    els.tabAnimation.classList.remove('active');
    
    // Inline styling correction for tabs
    els.tabSlices.style.borderBottomColor = 'var(--primary)';
    els.tabSlices.style.color = 'var(--text-main)';
    els.tabAnimation.style.borderBottomColor = 'transparent';
    els.tabAnimation.style.color = 'var(--text-muted)';

    els.viewSlices.classList.remove('hidden');
    els.viewAnimation.classList.add('hidden');

    // Show standard export footer
    document.querySelector('.export-footer').classList.remove('hidden');

    stopAnimPlayback();
  } else {
    els.tabSlices.classList.remove('active');
    els.tabAnimation.classList.add('active');

    els.tabSlices.style.borderBottomColor = 'transparent';
    els.tabSlices.style.color = 'var(--text-muted)';
    els.tabAnimation.style.borderBottomColor = 'var(--primary)';
    els.tabAnimation.style.color = 'var(--text-main)';

    els.viewSlices.classList.add('hidden');
    els.viewAnimation.classList.remove('hidden');

    // Hide standard export footer
    document.querySelector('.export-footer').classList.add('hidden');

    updateAnimationPlayer();
    startAnimPlayback();
  }
}

function startAnimPlayback() {
  if (state.anim.isPlaying) return;
  state.anim.isPlaying = true;
  els.btnAnimPlay.textContent = 'Pause';
  tickAnimPlayback();
}

export function stopAnimPlayback() {
  state.anim.isPlaying = false;
  els.btnAnimPlay.textContent = 'Play';
  if (state.anim.timer) {
    clearTimeout(state.anim.timer);
    state.anim.timer = null;
  }
}

function toggleAnimPlayback() {
  if (state.anim.isPlaying) {
    stopAnimPlayback();
  } else {
    startAnimPlayback();
  }
}

function handleAnimFpsChange(e) {
  const fps = parseInt(e.target.value) || 10;
  state.anim.fps = fps;
  els.labelAnimFps.querySelector('strong').textContent = `${fps} FPS`;
  
  if (state.anim.isPlaying) {
    stopAnimPlayback();
    startAnimPlayback();
  }
}

function tickAnimPlayback() {
  if (!state.anim.isPlaying) return;

  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) {
      stopAnimPlayback();
      return;
    }
    state.anim.currentFrame = (state.anim.currentFrame + 1) % enabledFrames.length;
    drawAnimFrame();
    state.anim.timer = setTimeout(tickAnimPlayback, 1000 / state.anim.fps);
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) {
    stopAnimPlayback();
    return;
  }

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) {
    stopAnimPlayback();
    return;
  }

  state.anim.currentFrame = (state.anim.currentFrame + 1) % enabledSlices.length;
  drawAnimFrame();

  state.anim.timer = setTimeout(tickAnimPlayback, 1000 / state.anim.fps);
}

export function updateAnimationPlayer() {
  if (state.workspaceMode === 'video') {
    if (state.video.frames.length === 0) {
      els.animCanvas.style.display = 'none';
      els.animNoFramesMsg.style.display = 'block';
      els.btnExportGif.disabled = true;
      els.btnExportWebm.disabled = true;
      els.animFrameIdx.textContent = '0';
      els.animFrameTotal.textContent = '0';
      stopAnimPlayback();
      return;
    }

    const enabledFrames = state.video.frames.filter(f => f.enabled);
    els.animFrameTotal.textContent = enabledFrames.length;

    if (enabledFrames.length === 0) {
      els.animCanvas.style.display = 'none';
      els.animNoFramesMsg.style.display = 'block';
      els.btnExportGif.disabled = true;
      els.btnExportWebm.disabled = true;
      els.animFrameIdx.textContent = '0';
      stopAnimPlayback();
    } else {
      els.animCanvas.style.display = 'block';
      els.animNoFramesMsg.style.display = 'none';
      els.btnExportGif.disabled = false;
      els.btnExportWebm.disabled = false;

      if (state.anim.currentFrame >= enabledFrames.length) {
        state.anim.currentFrame = 0;
      }
      
      drawAnimFrame();
      if (state.anim.isPlaying && state.anim.activeTab === 'animation') {
        if (!state.anim.timer) {
          state.anim.isPlaying = false;
          startAnimPlayback();
        }
      }
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) {
    els.animCanvas.style.display = 'none';
    els.animNoFramesMsg.style.display = 'block';
    els.btnExportGif.disabled = true;
    els.btnExportWebm.disabled = true;
    els.animFrameIdx.textContent = '0';
    els.animFrameTotal.textContent = '0';
    stopAnimPlayback();
    return;
  }

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  els.animFrameTotal.textContent = enabledSlices.length;

  if (enabledSlices.length === 0) {
    els.animCanvas.style.display = 'none';
    els.animNoFramesMsg.style.display = 'block';
    els.btnExportGif.disabled = true;
    els.btnExportWebm.disabled = true;
    els.animFrameIdx.textContent = '0';
    stopAnimPlayback();
  } else {
    els.animCanvas.style.display = 'block';
    els.animNoFramesMsg.style.display = 'none';
    els.btnExportGif.disabled = false;
    els.btnExportWebm.disabled = false;

    if (state.anim.currentFrame >= enabledSlices.length) {
      state.anim.currentFrame = 0;
    }
    
    drawAnimFrame();
    if (state.anim.isPlaying && state.anim.activeTab === 'animation') {
      if (!state.anim.timer) {
        state.anim.isPlaying = false;
        startAnimPlayback();
      }
    }
  }
}

function drawAnimFrame() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    if (state.anim.currentFrame >= enabledFrames.length) {
      state.anim.currentFrame = 0;
    }

    const frame = enabledFrames[state.anim.currentFrame];
    if (!frame) return;

    els.animFrameIdx.textContent = state.anim.currentFrame + 1;

    els.animCanvas.width = frame.canvas.width;
    els.animCanvas.height = frame.canvas.height;
    const animCtx = els.animCanvas.getContext('2d');
    animCtx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
    animCtx.drawImage(frame.processedCanvas, 0, 0);
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  const slice = enabledSlices[state.anim.currentFrame];
  if (!slice) return;

  els.animFrameIdx.textContent = state.anim.currentFrame + 1;

  els.animCanvas.width = slice.width;
  els.animCanvas.height = slice.height;
  const animCtx = els.animCanvas.getContext('2d');
  animCtx.clearRect(0, 0, slice.width, slice.height);

  const imgSource = activeFile.processedCanvas || activeFile.imgElement;
  animCtx.drawImage(
    imgSource,
    slice.x, slice.y, slice.width, slice.height,
    0, 0, slice.width, slice.height
  );
}

function exportAnimationGif() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    showProgressBar(true);
    updateProgressBar('Preparing frames for GIF conversion...', 10);

    const images = [];
    try {
      for (let i = 0; i < enabledFrames.length; i++) {
        const frame = enabledFrames[i];
        images.push(frame.processedCanvas.toDataURL('image/png'));
      }

      updateProgressBar('Generating GIF file...', 50);

      gifshot.createGIF({
        images: images,
        interval: 1 / state.anim.fps,
        gifWidth: enabledFrames[0].canvas.width,
        gifHeight: enabledFrames[0].canvas.height,
        numWorkers: 2
      }, function (obj) {
        showProgressBar(false);
        if (!obj.error) {
          const link = document.createElement('a');
          link.href = obj.image;
          const cleanName = state.video.file.name.substring(0, state.video.file.name.lastIndexOf('.')) || 'video';
          link.download = `${cleanName}_animation.gif`;
          link.click();
          showToast('Success', 'GIF animation exported successfully!', 'success');
        } else {
          console.error(obj.error);
          showToast('GIF Error', 'Failed to compile GIF frames.', 'error');
        }
      });
    } catch (err) {
      console.error(err);
      showProgressBar(false);
      showToast('GIF Error', 'Failed to generate GIF file.', 'error');
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Preparing frames for GIF conversion...', 10);

  const images = [];
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  const imgSource = activeFile.processedCanvas || activeFile.imgElement;

  try {
    for (let i = 0; i < enabledSlices.length; i++) {
      const slice = enabledSlices[i];
      tempCanvas.width = slice.width;
      tempCanvas.height = slice.height;
      tempCtx.clearRect(0, 0, slice.width, slice.height);
      tempCtx.drawImage(
        imgSource,
        slice.x, slice.y, slice.width, slice.height,
        0, 0, slice.width, slice.height
      );
      images.push(tempCanvas.toDataURL('image/png'));
    }

    updateProgressBar('Generating GIF file...', 50);

    gifshot.createGIF({
      images: images,
      interval: 1 / state.anim.fps,
      gifWidth: enabledSlices[0].width,
      gifHeight: enabledSlices[0].height,
      numWorkers: 2
    }, function (obj) {
      showProgressBar(false);
      if (!obj.error) {
        const link = document.createElement('a');
        link.href = obj.image;
        const cleanName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
        link.download = `${cleanName}_animation.gif`;
        link.click();
        showToast('Success', 'GIF animation exported successfully!', 'success');
      } else {
        console.error(obj.error);
        showToast('GIF Error', 'Failed to compile GIF frames.', 'error');
      }
    });

  } catch (err) {
    console.error(err);
    showProgressBar(false);
    showToast('GIF Error', 'Failed to generate GIF file.', 'error');
  }
}

function exportAnimationWebm() {
  if (state.workspaceMode === 'video') {
    const enabledFrames = state.video.frames.filter(f => f.enabled);
    if (enabledFrames.length === 0) return;

    showProgressBar(true);
    updateProgressBar('Recording WebM canvas stream...', 0);

    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = enabledFrames[0].canvas.width;
      tempCanvas.height = enabledFrames[0].canvas.height;
      const tempCtx = tempCanvas.getContext('2d');

      const stream = tempCanvas.captureStream(state.anim.fps);
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const cleanName = state.video.file.name.substring(0, state.video.file.name.lastIndexOf('.')) || 'video';
        link.download = `${cleanName}_animation.webm`;
        link.click();
        showProgressBar(false);
        showToast('Success', 'WebM animation exported successfully!', 'success');
      };

      mediaRecorder.start();

      let frameIdx = 0;

      const recordInterval = setInterval(() => {
        if (frameIdx >= enabledFrames.length) {
          clearInterval(recordInterval);
          mediaRecorder.stop();
          return;
        }

        const frame = enabledFrames[frameIdx];
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(frame.processedCanvas, 0, 0);

        frameIdx++;
        updateProgressBar(`Recording frame ${frameIdx}/${enabledFrames.length}`, Math.round((frameIdx / enabledFrames.length) * 100));
      }, 1000 / state.anim.fps);

    } catch (err) {
      console.error(err);
      showProgressBar(false);
      showToast('WebM Error', 'Failed to generate WebM file.', 'error');
    }
    return;
  }

  const activeFile = getActiveFile();
  if (!activeFile) return;

  const enabledSlices = activeFile.slices.filter(s => s.enabled);
  if (enabledSlices.length === 0) return;

  showProgressBar(true);
  updateProgressBar('Recording WebM canvas stream...', 0);

  try {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = enabledSlices[0].width;
    tempCanvas.height = enabledSlices[0].height;
    const tempCtx = tempCanvas.getContext('2d');

    const stream = tempCanvas.captureStream(state.anim.fps);
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const cleanName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
      link.download = `${cleanName}_animation.webm`;
      link.click();
      showProgressBar(false);
      showToast('Success', 'WebM animation exported successfully!', 'success');
    };

    mediaRecorder.start();

    const imgSource = activeFile.processedCanvas || activeFile.imgElement;
    let frameIdx = 0;

    const recordInterval = setInterval(() => {
      if (frameIdx >= enabledSlices.length) {
        clearInterval(recordInterval);
        mediaRecorder.stop();
        return;
      }

      const slice = enabledSlices[frameIdx];
      tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
      tempCtx.drawImage(
        imgSource,
        slice.x, slice.y, slice.width, slice.height,
        0, 0, tempCanvas.width, tempCanvas.height
      );

      frameIdx++;
      updateProgressBar(`Recording frame ${frameIdx}/${enabledSlices.length}`, Math.round((frameIdx / enabledSlices.length) * 100));
    }, 1000 / state.anim.fps);

  } catch (err) {
    console.error(err);
    showProgressBar(false);
    showToast('WebM Error', 'Failed to generate WebM file.', 'error');
  }
}

export function bindAnimEvents() {
  // Preview Tabs Event
  els.tabSlices.addEventListener('click', () => switchPreviewTab('slices'));
  els.tabAnimation.addEventListener('click', () => switchPreviewTab('animation'));

  // Animation Playback Events
  els.btnAnimPlay.addEventListener('click', toggleAnimPlayback);
  els.animFps.addEventListener('input', handleAnimFpsChange);
  els.btnExportGif.addEventListener('click', exportAnimationGif);
  els.btnExportWebm.addEventListener('click', exportAnimationWebm);
}
