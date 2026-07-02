/**
 * Video Frame Extraction Engine
 *
 * Two strategies, both frame-accurate:
 *
 * 1. 'all' mode — real-time playback capture driven by requestVideoFrameCallback.
 *    Every frame the browser actually presents is captured with its exact
 *    mediaTime, so the native frame rate is honored (no 30fps guessing) and no
 *    duplicate frames are produced. Dropped frames (rare, under load) are
 *    detected via mediaTime gaps and back-filled with precise seeks.
 *
 * 2. 'interval' mode — precise seeking. Each seek waits for BOTH the 'seeked'
 *    event and a presented frame (rVFC) so the captured canvas is guaranteed to
 *    show the requested time, fixing the "stale frame" races of naive
 *    seeked-only capture.
 *
 * Falls back to seeked-only waiting when requestVideoFrameCallback is
 * unavailable.
 */

const hasRVFC = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function createVideo(url) {
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  return video;
}

function waitForMetadata(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('Failed to load video for extraction.')), { once: true });
  });
}

/**
 * Some WebM files (e.g. MediaRecorder output) report duration as Infinity
 * until forced to scan; seeking far past the end makes the browser compute
 * the real duration.
 */
export function resolveVideoDuration(video) {
  return new Promise((resolve) => {
    if (isFinite(video.duration)) return resolve(video.duration);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('durationchange', onDurationChange);
      try { video.currentTime = 0; } catch { /* noop */ }
      resolve(isFinite(video.duration) ? video.duration : 0);
    };
    const onDurationChange = () => {
      if (isFinite(video.duration)) finish();
    };

    video.addEventListener('durationchange', onDurationChange);
    try {
      video.currentTime = Number.MAX_SAFE_INTEGER;
    } catch {
      finish();
      return;
    }
    setTimeout(finish, 3000);
  });
}

function captureFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Seeks to a time and resolves once a frame for (approximately) that time has
 * actually been presented and is safe to draw.
 */
function seekToTime(video, time) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (mediaTime) => {
      if (done) return;
      done = true;
      resolve(mediaTime);
    };

    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      if (hasRVFC) {
        // Frame may not be composited yet right after 'seeked'; wait for the
        // actual presentation callback (with a timeout fallback for paused
        // videos on some platforms).
        const timeout = setTimeout(() => finish(video.currentTime), 250);
        video.requestVideoFrameCallback((_now, metadata) => {
          clearTimeout(timeout);
          finish(metadata.mediaTime);
        });
      } else {
        finish(video.currentTime);
      }
    };

    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

/**
 * Interval-based extraction via precise seeking.
 */
async function extractByInterval(video, start, end, interval, onProgress) {
  const frames = [];
  // Integer-step loop avoids floating point drift accumulating across frames.
  const count = Math.floor((end - start) / interval + 1e-6) + 1;

  for (let i = 0; i < count; i++) {
    const targetTime = Math.min(start + i * interval, video.duration);
    await seekToTime(video, targetTime);
    frames.push({
      index: frames.length,
      time: targetTime,
      canvas: captureFrame(video),
      enabled: true
    });
    if (onProgress) onProgress(i + 1, count);
  }

  return frames;
}

/**
 * Native-framerate extraction via playback capture.
 */
async function extractAllFrames(video, start, end, onProgress) {
  const frames = [];
  const seenTimes = new Set();
  const EPS = 0.0005;

  await seekToTime(video, start);

  // Capture the very first frame at the start boundary.
  frames.push({ time: video.currentTime, canvas: captureFrame(video) });
  seenTimes.add(Math.round(video.currentTime / EPS));

  await new Promise((resolve, reject) => {
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      resolve();
    };

    const onFrame = (_now, metadata) => {
      if (stopped) return;
      const t = metadata.mediaTime;
      if (t > end + EPS) {
        stop();
        return;
      }
      const key = Math.round(t / EPS);
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        frames.push({ time: t, canvas: captureFrame(video) });
        if (onProgress) {
          onProgress(Math.min(1, (t - start) / Math.max(end - start, 0.001)));
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };

    video.addEventListener('ended', stop, { once: true });
    video.addEventListener('error', () => reject(new Error('Playback failed during extraction.')), { once: true });
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(reject);
  });

  frames.sort((a, b) => a.time - b.time);

  // Detect dropped frames: estimate frame duration from the median gap, then
  // back-fill any gap larger than 1.5x that duration with precise seeks.
  if (frames.length >= 3) {
    const gaps = [];
    for (let i = 1; i < frames.length; i++) {
      gaps.push(frames[i].time - frames[i - 1].time);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    if (median > 0) {
      const missing = [];
      for (let i = 1; i < frames.length; i++) {
        const gap = frames[i].time - frames[i - 1].time;
        if (gap > median * 1.5) {
          const n = Math.round(gap / median) - 1;
          for (let k = 1; k <= n; k++) {
            missing.push(frames[i - 1].time + median * k);
          }
        }
      }

      for (const t of missing) {
        const actual = await seekToTime(video, t);
        const key = Math.round((actual ?? t) / EPS);
        if (!seenTimes.has(key)) {
          seenTimes.add(key);
          frames.push({ time: actual ?? t, canvas: captureFrame(video) });
        }
      }
      frames.sort((a, b) => a.time - b.time);
    }
  }

  return frames.map((f, i) => ({ index: i, time: f.time, canvas: f.canvas, enabled: true }));
}

/**
 * Fallback for browsers without requestVideoFrameCallback: seek at an assumed
 * 30fps cadence (matches the legacy behavior).
 */
async function extractAllFramesFallback(video, start, end, onProgress) {
  return extractByInterval(video, start, end, 1 / 30, onProgress);
}

/**
 * Extracts frames from a video URL.
 *
 * @param {Object} params
 * @param {string} params.url - Object URL of the video
 * @param {number} params.start - Range start (seconds)
 * @param {number} params.end - Range end (seconds)
 * @param {'all'|'interval'} params.mode
 * @param {number} [params.interval] - Seconds between frames (interval mode)
 * @param {(info: {label: string, percent: number}) => void} [params.onProgress]
 * @returns {Promise<Array<{index:number, time:number, canvas:HTMLCanvasElement, enabled:boolean}>>}
 */
export async function extractFrames({ url, start, end, mode, interval, onProgress }) {
  const video = createVideo(url);
  await waitForMetadata(video);

  const duration = await resolveVideoDuration(video);
  const rangeStart = Math.max(0, Math.min(start, duration));
  const rangeEnd = Math.min(end, duration);
  if (rangeStart >= rangeEnd) {
    throw new Error('Start time must be less than end time.');
  }

  // Wait until enough data is buffered to decode.
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      video.addEventListener('loadeddata', resolve, { once: true });
    });
  }

  let frames;
  if (mode === 'all') {
    const report = onProgress
      ? (ratio) => onProgress({ label: `Capturing frames... ${Math.round(ratio * 100)}%`, percent: Math.round(ratio * 100) })
      : null;
    frames = hasRVFC
      ? await extractAllFrames(video, rangeStart, rangeEnd, report)
      : await extractAllFramesFallback(video, rangeStart, rangeEnd, onProgress
          ? (done, total) => onProgress({ label: `Extracting frame ${done}/${total}`, percent: Math.round((done / total) * 100) })
          : null);
  } else {
    frames = await extractByInterval(video, rangeStart, rangeEnd, Math.max(0.01, interval || 0.2), onProgress
      ? (done, total) => onProgress({ label: `Extracting frame ${done}/${total}`, percent: Math.round((done / total) * 100) })
      : null);
  }

  // Release the element's decoder resources.
  video.removeAttribute('src');
  video.load();

  return frames;
}
