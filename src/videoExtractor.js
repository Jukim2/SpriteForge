/**
 * Video Frame Extraction Engine
 *
 * Fast path — WebCodecs. MP4/MOV/WebM/MKV files are demuxed with mediabunny
 * and decoded through VideoDecoder, so frames come out as fast as the decoder
 * can run (typically 10-50x realtime) instead of waiting on playback or
 * per-frame seeks. Interval extraction decodes each packet at most once and
 * seeks by keyframe, so sparse intervals stay cheap. Rotation metadata, pixel
 * aspect ratio, and alpha (transparent WebM) are honored, matching what a
 * <video> element would display.
 *
 * Fallback path — <video> element capture, used for unrecognized containers,
 * browsers without WebCodecs, or codecs the decoder rejects:
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
 */

import { Input, ALL_FORMATS, BufferSource as MediaBufferSource, VideoSampleSink, EncodedPacketSink } from 'mediabunny';

// ---------------------------------------------------------------------------
// WebCodecs fast path
// ---------------------------------------------------------------------------

const hasWebCodecs = typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';

const TIME_EPS = 1e-4;

/** Draws a decoded sample to a fresh canvas (rotation/aspect applied by mediabunny). */
function sampleToCanvas(sample) {
  const canvas = document.createElement('canvas');
  canvas.width = sample.displayWidth;
  canvas.height = sample.displayHeight;
  sample.draw(canvas.getContext('2d'), 0, 0);
  return canvas;
}

/**
 * Demuxes with mediabunny and decodes through VideoDecoder.
 *
 * The displayed frame at time t is the last frame with pts <= t (what a seek
 * to t would show); interval targets snap to that frame. Interval extraction
 * uses mediabunny's sorted-timestamp pipeline, which seeks by keyframe and
 * decodes each packet at most once.
 */
async function extractViaWebCodecs({ buffer, start, end, mode, interval, onProgress }) {
  let lastPercent = -1;
  const report = (label, percent) => {
    if (!onProgress || percent === lastPercent) return;
    lastPercent = percent;
    onProgress({ label, percent });
  };
  report('Demuxing video...', 0);

  const input = new Input({ source: new MediaBufferSource(buffer), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');

    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error('Could not determine a decoder configuration.');
    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Codec ${decoderConfig.codec} is not supported by this browser's WebCodecs decoder.`);
    }

    // computeDuration can report the last frame's start rather than its end
    // for some containers (WebM); take whichever of the packet-derived and
    // container-metadata durations is later so the tail of the range matches
    // what a <video> element reports as duration.
    const packetSink = new EncodedPacketSink(track);
    const lastPacket = await packetSink.getPacket(Infinity, { metadataOnly: true });
    const metadataDuration = await track.getDurationFromMetadata().catch(() => null);
    const duration = Math.max(
      await track.computeDuration(),
      metadataDuration || 0,
      lastPacket ? lastPacket.timestamp + (lastPacket.duration || 0) : 0
    );
    const rangeStart = Math.max(0, Math.min(start, duration));
    const rangeEnd = Math.min(end, duration);
    if (rangeStart >= rangeEnd) {
      throw new Error('Start time must be less than end time.');
    }

    const sink = new VideoSampleSink(track);
    const results = [];
    const emit = (sample, time) => {
      results.push({ index: results.length, time, canvas: sampleToCanvas(sample), enabled: true });
    };

    // Sync flags stored in containers can lie (e.g. every sample marked as a
    // keyframe); verifying against the bitstream keeps decoding from starting
    // on a delta frame.
    const retrieval = { verifyKeyPackets: true };

    if (mode === 'interval') {
      const count = Math.floor((rangeEnd - rangeStart) / interval + 1e-6) + 1;
      const targets = [];
      for (let i = 0; i < count; i++) {
        targets.push(Math.min(rangeStart + i * interval, duration));
      }
      // Clamp lookups into [first frame, last frame]: timestamps outside the
      // track's frame range snap to the nearest frame, matching what a
      // <video> seek would display.
      const firstTimestamp = await track.getFirstTimestamp();
      const lastTimestamp = lastPacket ? lastPacket.timestamp : duration;
      const lookups = targets.map((t) => Math.min(Math.max(t, firstTimestamp), lastTimestamp));

      const reportTarget = (i) => report(`Extracting frame ${i}/${targets.length}`, Math.round((i / targets.length) * 100));

      // Fast plan: keyframe-seeking lookups, decoding only the GOPs that
      // contain targets. Requires a working random-access index, which some
      // containers lack (e.g. fragmented MP4s from MediaRecorder), so probe
      // first and bail out if any lookup comes back empty.
      let complete = false;
      const probe = await packetSink.getKeyPacket(lookups[lookups.length - 1], { verifyKeyPackets: true }).catch(() => null);
      if (probe) {
        complete = true;
        // Consecutive targets can resolve to the same sample object, so close
        // a sample only once the iterator has moved past it.
        let held = null;
        let i = 0;
        for await (const sample of sink.samplesAtTimestamps(lookups, retrieval)) {
          if (!sample) {
            complete = false;
            break;
          }
          emit(sample, targets[i]);
          if (held && held !== sample) held.close();
          held = sample;
          i++;
          reportTarget(i);
        }
        if (held) held.close();
      }

      // Robust plan: one streaming decode pass over [first target, last
      // target], snapping each target to the last frame at/before it.
      if (!complete) {
        results.length = 0;
        let prev = null;
        let ti = 0;
        for await (const sample of sink.samples(lookups[0], lookups[lookups.length - 1] + TIME_EPS, retrieval)) {
          while (ti < targets.length && sample.timestamp > lookups[ti] + TIME_EPS) {
            emit(prev || sample, targets[ti]);
            ti++;
            reportTarget(ti);
          }
          if (prev) prev.close();
          prev = sample;
          if (ti >= targets.length) break;
        }
        while (ti < targets.length && prev) {
          emit(prev, targets[ti]);
          ti++;
          reportTarget(ti);
        }
        if (prev) prev.close();
      }
    } else {
      // Starts at the frame displayed at rangeStart; the +EPS keeps a frame
      // landing exactly on rangeEnd inside the (exclusive) upper bound.
      for await (const sample of sink.samples(rangeStart, rangeEnd + TIME_EPS, retrieval)) {
        emit(sample, sample.timestamp);
        sample.close();
        const ratio = (sample.timestamp - rangeStart) / Math.max(rangeEnd - rangeStart, 0.001);
        report(`Decoding frames... ${Math.round(ratio * 100)}%`, Math.round(ratio * 100));
      }
    }

    if (!results.length) throw new Error('No frames found in the specified range.');
    return results;
  } finally {
    if (typeof input.dispose === 'function') input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Fallback path — <video> element playback/seek capture
// ---------------------------------------------------------------------------

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
 * Extraction via a <video> element (playback capture / precise seeks).
 */
async function extractViaVideoElement({ url, start, end, mode, interval, onProgress }) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts frames from a video URL. Containers mediabunny recognizes
 * (MP4/MOV/WebM/MKV) decode through WebCodecs when available (much faster
 * than realtime); everything else — and any WebCodecs failure — falls back
 * to <video> element capture.
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
  if (hasWebCodecs) {
    try {
      const buffer = await (await fetch(url)).arrayBuffer();
      return await extractViaWebCodecs({
        buffer,
        start,
        end,
        mode,
        interval: Math.max(0.01, interval || 0.2),
        onProgress,
      });
    } catch (err) {
      console.warn('[videoExtractor] WebCodecs fast path failed; falling back to playback capture.', err);
    }
  }
  return extractViaVideoElement({ url, start, end, mode, interval, onProgress });
}
