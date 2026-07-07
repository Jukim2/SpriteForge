import { createServer } from 'vite';
import { chromium } from 'playwright';

const step = (m) => console.log(`[runner] ${m}`);

const server = await createServer({ server: { port: 5199, strictPort: true } });
await server.listen();
step('vite dev server up');

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
page.setDefaultTimeout(60000);
const messages = [];
page.on('console', (m) => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => messages.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:5199/dev-test/index.html');
await page.waitForFunction(() => window.__ready);
step('test page ready');

const result = await page.evaluate(async () => {
  const W = 320, H = 240, FPS = 30, FRAMES = 90; // 3s, keyframe every 1s => 3 GOPs
  const duration = FRAMES / FPS;
  const expectedRed = (i) => Math.round(255 * i / (FRAMES - 1));

  const drawRamp = (ctx, i) => {
    ctx.fillStyle = `rgb(${expectedRed(i)},128,64)`;
    ctx.fillRect(0, 0, W, H);
  };

  // --- Regular MP4 / WebM via mediabunny muxing + CanvasSource encoding ---
  async function makeVideo(format, codec) {
    const { Output, BufferTarget, CanvasSource } = window.MB;
    const output = new Output({ format, target: new BufferTarget() });
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const source = new CanvasSource(canvas, { codec, bitrate: 2_000_000, keyFrameInterval: 1 });
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < FRAMES; i++) {
      ctx.clearRect(0, 0, W, H);
      drawRamp(ctx, i);
      await source.add(i / FPS, 1 / FPS);
    }
    await output.finalize();
    return URL.createObjectURL(new Blob([output.target.buffer]));
  }

  // --- "Quirky" fragmented MP4 via mp4box: packet flags are readable but the
  // random-access (keyframe) index is not, forcing the streaming fallback ---
  async function makeQuirkyMp4() {
    const TIMESCALE = 90000;
    const chunks = [];
    let description = null;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !description) {
          const d = metadata.decoderConfig.description;
          description = d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
      },
      error: (e) => { throw e; },
    });
    encoder.configure({
      codec: 'avc1.42001f', width: W, height: H, framerate: FPS,
      bitrate: 2_000_000, avc: { format: 'avc' },
    });
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < FRAMES; i++) {
      drawRamp(ctx, i);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % FPS === 0 });
      frame.close();
    }
    await encoder.flush();
    encoder.close();

    const file = window.MP4.createFile();
    const trackId = file.addTrack({ timescale: TIMESCALE, width: W, height: H, avcDecoderConfigRecord: description });
    for (const c of chunks) {
      file.addSample(trackId, c.data, {
        duration: TIMESCALE / FPS,
        cts: Math.round(c.timestamp * TIMESCALE / 1e6),
        dts: Math.round(c.timestamp * TIMESCALE / 1e6),
        is_sync: c.type === 'key',
      });
    }
    return URL.createObjectURL(new Blob([file.getBuffer().buffer], { type: 'video/mp4' }));
  }

  // --- Alpha WebM: VP9 color stream + VP9 alpha stream as block-additional
  // side data (the layout ffmpeg produces for yuva420p WebM) ---
  async function makeAlphaWebm() {
    const N = 30;
    const encodeStream = async (drawFn) => {
      const chunks = [];
      let cfg = null;
      const enc = new VideoEncoder({
        output: (c, m) => {
          if (m && m.decoderConfig && !cfg) cfg = m.decoderConfig;
          const d = new Uint8Array(c.byteLength);
          c.copyTo(d);
          chunks.push({ type: c.type, ts: c.timestamp, dur: c.duration || Math.round(1e6 / FPS), data: d });
        },
        error: (e) => { throw e; },
      });
      enc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrate: 2_000_000, framerate: FPS });
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < N; i++) {
        drawFn(ctx, i);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      await enc.flush();
      enc.close();
      return { chunks, cfg };
    };

    const color = await encodeStream((ctx) => {
      ctx.fillStyle = 'rgb(0,200,0)';
      ctx.fillRect(0, 0, W, H);
    });
    const alpha = await encodeStream((ctx) => {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'white';
      ctx.fillRect(W / 2, 0, W / 2, H); // right half opaque
    });

    const { Output, WebMOutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } = window.MB;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const source = new EncodedVideoPacketSource('vp9');
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < color.chunks.length; i++) {
      const c = color.chunks[i];
      const a = alpha.chunks[i];
      const packet = new EncodedPacket(
        c.data, c.type, c.ts / 1e6, c.dur / 1e6,
        undefined, undefined, { alpha: a.data }
      );
      await source.add(packet, i === 0 ? { decoderConfig: color.cfg } : undefined);
    }
    await output.finalize();
    return URL.createObjectURL(new Blob([output.target.buffer], { type: 'video/webm' }));
  }

  const px = (c, fx = 0.5, fy = 0.5) => {
    const d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  async function runSuite(url) {
    const suite = {};
    {
      const t1 = performance.now();
      const frames = await window.extractFrames({ url, start: 0, end: duration, mode: 'all' });
      suite.all = {
        elapsedMs: Math.round(performance.now() - t1),
        count: frames.length,
        timesMonotonic: frames.every((f, i) => i === 0 || f.time > frames[i - 1].time),
        size: [frames[0].canvas.width, frames[0].canvas.height],
        firstRed: px(frames[0].canvas)[0],
        midRed: px(frames[Math.floor(frames.length / 2)].canvas)[0],
        lastRed: px(frames[frames.length - 1].canvas)[0],
      };
    }
    {
      const t1 = performance.now();
      const frames = await window.extractFrames({ url, start: 0, end: duration, mode: 'interval', interval: 0.5 });
      suite.interval = {
        elapsedMs: Math.round(performance.now() - t1),
        count: frames.length,
        times: frames.map((f) => +f.time.toFixed(3)),
        reds: frames.map((f) => px(f.canvas)[0]),
        expectedReds: frames.map((f) => Math.round(255 * Math.min(Math.floor(f.time * FPS), FRAMES - 1) / (FRAMES - 1))),
      };
    }
    {
      // start=0.99 sits between frames 29 (0.9667) and 30 (1.0): the extractor
      // must begin with the frame *displayed* at 0.99, i.e. pts 0.9667.
      const frames = await window.extractFrames({ url, start: 0.99, end: 2.0, mode: 'all' });
      suite.range = {
        count: frames.length,
        firstTime: +frames[0].time.toFixed(4),
        lastTime: +frames[frames.length - 1].time.toFixed(4),
      };
    }
    {
      const frames = await window.extractFrames({ url, start: 0, end: duration, mode: 'interval', interval: 2.5 });
      suite.sparse = {
        count: frames.length,
        times: frames.map((f) => +f.time.toFixed(3)),
        reds: frames.map((f) => px(f.canvas)[0]),
      };
    }
    return suite;
  }

  const { Mp4OutputFormat, WebMOutputFormat } = window.MB;
  const out = {};
  out.mp4 = await runSuite(await makeVideo(new Mp4OutputFormat(), 'avc'));
  console.log('mp4 suite done');
  out.webm = await runSuite(await makeVideo(new WebMOutputFormat(), 'vp9'));
  console.log('webm suite done');
  out.quirkyMp4 = await runSuite(await makeQuirkyMp4());
  console.log('quirky mp4 suite done');

  {
    const url = await makeAlphaWebm();
    const frames = await window.extractFrames({ url, start: 0, end: 1, mode: 'interval', interval: 0.5 });
    out.alphaWebm = {
      count: frames.length,
      leftPx: px(frames[0].canvas, 0.25, 0.5),   // expect alpha 0
      rightPx: px(frames[0].canvas, 0.75, 0.5),  // expect alpha 255, green
    };
  }

  return out;
});

console.log(JSON.stringify(result, null, 2));
const fallbacks = messages.filter((m) => m.includes('falling back'));
console.log('FALLBACK WARNINGS:', fallbacks.length ? JSON.stringify(fallbacks) : 'none');
console.log('CONSOLE:', JSON.stringify(messages.filter((m) => !m.startsWith('[debug]')), null, 2));

await browser.close();
await server.close();
step('done');
