# SpriteForge

Local, browser-based toolkit for game/sprite art: sprite-sheet slicing,
AI upscaling (Real-ESRGAN), AI background removal, vectorizing, video frame
extraction, and animation preview/export. All inference runs **locally** —
images never leave your machine.

Two ways to use it:

1. **Web app** — the full interactive UI (`npm run dev`).
2. **Headless batch** — process whole folders from the command line, or drive
   it in natural language through the bundled **Claude Code skill**. Same code,
   same GPU pipeline, no browser clicking.

---

## Setup (new machine)

Prerequisites:
- **Node.js 18+**
- **Google Chrome** (desktop) — the headless batch runner uses your installed
  Chrome for reliable WebGPU (GPU acceleration). Not needed for the web app.
- A **WebGPU-capable GPU** for fast AI tools (falls back to CPU otherwise).

```bash
npm install
```

That's it. The AI models (`public/models/*.onnx`) are committed to the repo, so
they come with the clone — no separate download. Background-removal seg models
(anime-isnet / toonout / rmbg14) download from Hugging Face on first use and
cache locally afterward.

---

## Web app

```bash
npm run dev      # dev server (http://localhost:5173)
npm run build    # production build to dist/
npm run preview  # preview the build
```

---

## Batch / automation

### Via the Claude Code skill (natural language)

The project ships a Claude Code skill at `.claude/skills/sprite-batch/`. It is
**committed to the repo and auto-discovered — there is no manual registration
step.** Just open this project in Claude Code and ask, e.g.:

> "이 폴더 배경 지우고 4배 업스케일해줘"
> "upscale ./sprites 4x on the GPU"
> "remove backgrounds in ./chars and save as webp"

Claude runs the CLI below for you, picks the right GPU models, and reports which
backend each image used.

> If the skill doesn't show up: make sure you opened the project **root** (the
> folder containing this README) in Claude Code, and that
> `.claude/skills/sprite-batch/SKILL.md` is present. You can also invoke it
> explicitly by typing `/sprite-batch`.

### Via the CLI directly

One runner — **`scripts/sf-headless.mjs`** (`npm run headless`) — drives the real
app pipeline in a headless Chrome on the **GPU** where relevant. Output matches
the web app because it runs the app's own code.

Tools: `upscale`, `bgremove`, `vectorize`, `compress`, `chromakey` (1→1);
`slice` (sprite sheet → sprites) and `extract` (video → frames) (1→N);
`gif` (folder of frames → one animated GIF) (N→1).

```bash
# AI upscale a folder 4x on the GPU (fail loudly if it can't use the GPU)
node scripts/sf-headless.mjs ./sprites --tool upscale --model anime-best --scale 4 --require-gpu

# GPU background removal → transparent WebP
node scripts/sf-headless.mjs ./chars --tool bgremove --model anime-isnet --format webp --require-gpu

# Slice a sprite sheet on a 64x64 grid (or --auto to detect sprites)
node scripts/sf-headless.mjs ./sheets --tool slice --grid 64x64

# Chroma-key out a green screen
node scripts/sf-headless.mjs ./shots --tool chromakey --color "#00ff00" --tolerance 20

# Extract frames from videos every 0.5s, then assemble a GIF
node scripts/sf-headless.mjs ./clips --tool extract --interval 0.5
node scripts/sf-headless.mjs ./clips/clip_frames --tool gif --fps 12

# Vectorize pixel art to SVG · compress to WebP
node scripts/sf-headless.mjs ./icons --tool vectorize --mode pixel
node scripts/sf-headless.mjs ./art --tool compress --webp --quality 80
```

Run `node scripts/sf-headless.mjs --help` for the full option list.

### GPU notes

- AI upscale and the seg background-removal models (`anime-isnet`, `toonout`,
  `rmbg14`) run on **WebGPU** (your discrete GPU). Add `--require-gpu` so a
  silent CPU fallback fails loudly instead of running much slower.
- The imgly models (`isnet`, `isnet_fp16`, `isnet_quint8`) run on **CPU/WASM**
  by design (imgly's bundled runtime can't init WebGPU here). They still work —
  just don't pass `--require-gpu` with them. **For GPU background removal, use
  `anime-isnet`** (the default), which is also higher quality on game art.
- Each processed image prints its backend, e.g. `done 384x384 [webgpu] (1.2s)`.

---

## Project layout

```
index.html            Web app entry
headless.html         Headless harness — exposes the app pipeline to the CLI
                      (imports the SAME src/ code; no algorithm duplication)
src/                  App source
  upscaler.js         AI/xBR/smooth/nearest upscaling
  bgSegmenter.js      Advanced ONNX background segmentation (GPU worker)
  vectorizer.js       Raster → SVG
  features/, app/     UI features and shared modules
scripts/
  sf-headless.mjs     Browser-driven batch runner (all tools, GPU where relevant)
public/models/        Real-ESRGAN ONNX models (committed)
.claude/skills/       Claude Code skill (auto-discovered)
dev-test/             Playwright test harnesses + webgpu-probe.mjs
```

Adding a tool to the web app makes it batch-available by exposing it in
`headless.html` — the algorithms live in `src/` only and are never duplicated
in the Node scripts.
