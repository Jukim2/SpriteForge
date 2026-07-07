---
name: sprite-batch
description: Batch-process files/folders with SpriteForge from the command line using the real GPU-accelerated app pipeline — AI upscale, AI background removal, vectorize, compress, chroma-key, sprite-sheet slicing, video frame extraction, and GIF assembly. Use whenever the user wants to run SpriteForge tools over files/folders without the browser UI — e.g. "이 폴더 배경 지워줘", "스프라이트 4배 업스케일", "스프라이트시트 잘라줘", "영상에서 프레임 뽑아줘", "GIF로 만들어줘", "upscale these images", "remove backgrounds in bulk", "compress to webp", "vectorize", "slice a sprite sheet", "extract frames", "make a gif".
---

# SpriteForge batch processing

Run SpriteForge's tools over a folder without the web UI. One runner —
**`scripts/sf-headless.mjs`** (`npm run headless`) — drives the REAL app
pipeline in a headless Chrome, using the discrete GPU via WebGPU where relevant.
Output matches the web app because it runs the app's own code.

Tools (`--tool`):

| Tool | Shape | What it does |
|------|-------|--------------|
| `upscale` | 1→1 | AI (Real-ESRGAN) / xBR / smooth / nearest upscaling |
| `bgremove` | 1→1 | AI background removal |
| `vectorize` | 1→1 | raster → SVG |
| `compress` | 1→1 | re-encode (e.g. → WebP), no resize |
| `chromakey` | 1→1 | color-key (green/blue-screen) removal |
| `slice` | 1→N | sprite sheet → individual sprite PNGs (`<base>_slices/`) |
| `extract` | 1→N | video → frame images (`<base>_frames/`) |
| `gif` | N→1 | a folder of frames → one animated GIF |

## Choosing a model (do this before running)

The model choice depends on the **art type**. First try to infer it, then pick;
only ask the user when you genuinely can't tell.

**Step 1 — infer the art type** from what you already know: the user's words
("일러스트/캐릭터/스프라이트/픽셀아트" → game art; "사진/photo/제품" → photo), the
folder name, and if still unsure a quick look at one or two of the actual images
(they're local — you can Read one).

**Step 2 — map art type → model:**

| Task | Game art / illustration / anime | Photo / realistic / product |
|------|--------------------------------|------------------------------|
| **upscale** | `anime-best` (default) | `general-best` |
| **bgremove** | `anime-isnet` (default, GPU) — or `toonout` for the cleanest anime edges | `rmbg14` (GPU) |

Fast/low-VRAM variants exist for upscale (`anime`, `general`) — only use them if
the user asks for speed. For bgremove, `isnet` / `isnet_fp16` / `isnet_quint8`
are CPU-only imgly fallbacks — avoid unless the GPU models fail.

**Step 3 — when to ASK vs just pick:**
- **Just pick** (and state which you chose + why) when the art type is clear, or
  when the user already named a model, or for a quick one-off. Don't over-ask.
- **Ask the user** (use AskUserQuestion) only when the art type is genuinely
  ambiguous AND it changes the model — e.g. a mixed folder, or you can't tell
  game-art from photo. Present a short labeled list, e.g.:
  - "Game art / illustration → anime-best" (recommended when unsure for this project)
  - "Photo / realistic → general-best"
  - "Fastest (lower quality) → anime"

  Keep it to the 2-3 options that actually apply to the detected task. Never
  dump the full raw model-key list on the user — translate to plain language.

## Usage

```
node scripts/sf-headless.mjs <folder> --tool <tool> [options]
```

Run `node scripts/sf-headless.mjs --help` for the full list. Key options:

Common:
- `--format` — `png` (default) | `webp`   ·   `--quality <1-100>` for webp
- `--out <dir>` — output subfolder (default `_out`)   ·   `--replace` (1→1 tools only)
- `--require-gpu` — hard-fail if AI work falls back to CPU/WASM (use for AI upscale + GPU seg bgremove)
- `--no-recursive` — top-level only

Per tool:
- **upscale** — `--model <anime-best|general-best|anime|general>` · `--algo <ai|xbr|smooth|nearest>` · `--scale <2|3|4>`
- **bgremove** — `--model <anime-isnet|toonout|rmbg14|isnet|isnet_fp16|isnet_quint8>`
- **vectorize** — `--mode <pixel|trace>` · `--colors <1-8>`
- **chromakey** — `--color <#00ff00>` · `--tolerance <0-100>` · `--no-contiguous` · `--despill <0-1>`
- **slice** — `--grid <WxH>` (or `--auto` for connected-component detection) · `--no-skip-empty` · `--alpha <0-255>` · `--merge-gap <px>`
- **extract** — `--interval <sec>` (omit = every frame) · `--start <sec>` · `--end <sec>`. Reads `.mp4/.mov/.webm/.mkv/.m4v`.
- **gif** — `--fps <n>` · `--suffix <name>`. Consumes all images in the folder, ordered by filename.

## GPU notes

- AI upscale and the seg bgremove models (`anime-isnet`, `toonout`, `rmbg14`)
  run on **WebGPU** (the discrete GPU). Add `--require-gpu` so a silent CPU
  fallback fails loudly instead of running 10-50x slower.
- The imgly models (`isnet*`) run on **CPU/WASM** by design — do NOT pass
  `--require-gpu` with those. Prefer `anime-isnet` for GPU background removal.
- Output reports the backend per image, e.g. `done 384x384 [webgpu] (1.2s)`.
  A `[wasm]` tag or the CPU warning at the end means it did not use the GPU.

## Examples

```bash
# AI upscale a sprite folder 4x on the GPU (fail if it can't use the GPU)
node scripts/sf-headless.mjs ./sprites --tool upscale --model anime-best --scale 4 --require-gpu

# Remove backgrounds on the GPU, output transparent WebP
node scripts/sf-headless.mjs ./chars --tool bgremove --model anime-isnet --format webp --require-gpu

# Vectorize pixel art to SVG
node scripts/sf-headless.mjs ./icons --tool vectorize --mode pixel

# Re-encode everything to WebP q80 (no upscale)
node scripts/sf-headless.mjs ./art --tool compress --webp --quality 80

# Slice sprite sheets on a fixed grid (or --auto to detect sprites)
node scripts/sf-headless.mjs ./sheets --tool slice --grid 64x64

# Chroma-key out a green screen
node scripts/sf-headless.mjs ./shots --tool chromakey --color "#00ff00" --tolerance 20

# Extract frames from videos every 0.5s
node scripts/sf-headless.mjs ./clips --tool extract --interval 0.5

# Assemble a folder of frames into one GIF
node scripts/sf-headless.mjs ./frames --tool gif --fps 12 --suffix walk_cycle
```

## Chaining tools (multi-step pipeline)

To run a pipeline (e.g. background-remove then upscale), run the first tool,
then run the next on the previous `--out` folder. Example: bgremove → upscale.

```bash
node scripts/sf-headless.mjs ./chars --tool bgremove --model anime-isnet --out _nobg --require-gpu
node scripts/sf-headless.mjs ./chars/_nobg --tool upscale --model anime-best --scale 4 --out _final --require-gpu
```

Results land in `./chars/_nobg/_final`. Always report to the user how many
images processed, which backend was used, and the output folder path.

## How it works (for maintenance)

`sf-headless.mjs` boots the vite dev server and loads `headless.html` (project
root) in Playwright-controlled Chrome (`channel: chrome`, `--headless=new`
plus WebGPU flags). `headless.html` imports the app's own `upscaleImage`,
`segmentBackground` / imgly `removeBackground`, `vectorizeImage`,
`sliceGrid`/`sliceAuto`, `chromaKeyCanvas`, `extractFrames`, and
`encodeCanvasToBlob`, so there is **one** implementation — the app's. The
algorithms are never duplicated; do not reimplement image logic in the Node
scripts.

**Adding a new tool** is thin wiring, not algorithm duplication: (1) expose a
method in `headless.html` that calls the relevant `src/` function, and (2) add a
`--tool` branch + handler in `sf-headless.mjs`. **Improving an existing tool**
needs zero changes here — edit `src/` and both the web app and this runner pick
it up automatically.
