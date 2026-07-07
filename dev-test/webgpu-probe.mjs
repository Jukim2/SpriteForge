// WebGPU headless probe (v2): serve from a real localhost origin (secure
// context, like the app harness) and try the launch configs most likely to
// expose a hardware GPU. Reports which adapter each config resolves to.
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { port: 5199, strictPort: true } });
await server.listen();
const ORIGIN = 'http://localhost:5199/';

const PROBE = async () => {
  const out = { hasNavigatorGpu: 'gpu' in navigator };
  if (!out.hasNavigatorGpu) return out;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { out.ok = false; out.reason = 'requestAdapter null'; return out; }
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const dev = await adapter.requestDevice().catch((e) => { out.deviceErr = String(e.message || e); return null; });
    out.ok = true;
    out.isFallbackAdapter = adapter.isFallbackAdapter;
    out.vendor = info.vendor;
    out.architecture = info.architecture;
    out.device = info.device;
    out.description = info.description;
    out.hasDevice = !!dev;
    out.maxBufferSizeMB = adapter.limits?.maxBufferSize ? Math.round(adapter.limits.maxBufferSize / 1048576) : undefined;
    return out;
  } catch (e) {
    out.ok = false; out.reason = String(e && e.message || e);
    return out;
  }
};

const WEBGPU_FEATURES = '--enable-features=Vulkan,UseSkiaRenderer';

const configs = [
  { name: 'chrome  · headless=new',        channel: 'chrome',   headless: true,
    args: ['--headless=new', '--enable-unsafe-webgpu', WEBGPU_FEATURES, '--ignore-gpu-blocklist'] },
  { name: 'chrome  · headed',              channel: 'chrome',   headless: false,
    args: ['--enable-unsafe-webgpu', WEBGPU_FEATURES, '--ignore-gpu-blocklist'] },
  { name: 'chromium· headed',              channel: 'chromium', headless: false,
    args: ['--enable-unsafe-webgpu', WEBGPU_FEATURES, '--ignore-gpu-blocklist'] },
  { name: 'chrome  · headed (angle-gl)',   channel: 'chrome',   headless: false,
    args: ['--enable-unsafe-webgpu', WEBGPU_FEATURES, '--ignore-gpu-blocklist', '--use-angle=gl'] },
];

for (const cfg of configs) {
  process.stdout.write(`\n=== ${cfg.name} ===\n`);
  let browser;
  try {
    browser = await chromium.launch({ channel: cfg.channel, headless: cfg.headless, args: cfg.args });
    const page = await browser.newPage();
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(PROBE);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('LAUNCH/RUN FAILED:', String(e && e.message || e).split('\n')[0]);
  } finally {
    if (browser) await browser.close();
  }
}

await server.close();
console.log('\n[probe] done');
