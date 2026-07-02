---
name: spriteforge
description: Launch the SpriteForge web app OR run headless batch upscaling on a local folder. Use when the user wants to start the local dev server, or to upscale/process a folder of images from the command line (e.g. "upscale this folder", "batch process ./sprites", "/spriteforge <folder>").
---

# SpriteForge

Two modes, chosen by whether the user names a folder.

## Mode A — Launch the web app (no folder given)

When the user just runs `/spriteforge` with no path, start the local dev server
so they can use the browser UI (slicer, video frames, image tools).

1. Start the server in the background:
   ```
   npm run dev
   ```
   (Runs Vite; the coi-serviceworker header setup and WebGPU AI upscaling need
   this real server — do not open index.html via file://.)
2. Read the background task output to get the URL (usually
   `http://localhost:5173/`), confirm it responds, and give the user the link.
3. Remind them WebGPU AI upscaling and folder write-back in the browser need
   **Chrome or Edge**.

## Mode B — Headless batch upscale (folder given)

When the user names a folder (and optionally an algorithm/scale), run the
headless CLI. This needs **no browser** — it reads and writes the local
filesystem directly, so it can point at a folder, process every image, and
write results back automatically.

Command:
```
npm run batch -- <folder> [options]
```
or directly:
```
node scripts/sf-batch.mjs <folder> [options]
```

### Options
- `--algo <ai|xbr|smooth|nearest>` (or shorthands `--ai` `--xbr` `--smooth` `--nearest`) — default `ai`
- `--model <anime-best|general-best|anime|general>` — AI model, default `anime-best`
  - `*-best` models are higher quality but slower on CPU. For quick runs use
    `anime` / `general` (the 5MB fast models).
- `--scale <2|3|4>` — default `4`
- `--no-recursive` — only top-level images (default scans subfolders)
- `--replace` — overwrite originals in place (⚠️ destructive; confirm first)
- `--out <dir>` — output subfolder name, default `_upscaled`
- `--suffix <text>` — filename suffix, default `_<algo>_x<scale>`

### Default behavior (safe)
Results go to `<folder>/_upscaled/…`, mirroring the original subfolder
structure. Originals are never touched unless `--replace` is passed.

### Picking the algorithm
- **Pixel art** → `--xbr` (edge-aware) or `--nearest` (crisp, no smoothing)
- **Illustrations / game/rendered art** → `--ai --model anime-best`
- **Photos / painted art** → `--ai --model general-best`, or `--smooth` for a
  fast plain resize

### Guidance when running it
- AI runs on **CPU** here (onnxruntime-node), so it's slower than the browser's
  WebGPU path. Warn the user if the folder is large; the `*-best` (esp. 67MB
  `general-best`) models are the slowest. Suggest a fast model or a small test
  run first.
- Before using `--replace`, confirm with the user — it overwrites originals.
- After it finishes, report how many succeeded/failed and where results landed.
- Supported inputs: PNG, JPEG, WebP. All outputs are PNG.

### Examples
```
node scripts/sf-batch.mjs ./sprites --ai --scale 4
node scripts/sf-batch.mjs ./sprites --xbr --scale 3
node scripts/sf-batch.mjs ./photos --ai --model general-best --no-recursive
node scripts/sf-batch.mjs ./sprites --nearest --scale 2 --replace
```

## Notes
- The CLI reuses the exact algorithms and Real-ESRGAN ONNX models from the web
  app (`public/models/`). Implementation: `scripts/sf-batch.mjs`.
- Requires the dev/native deps `sharp` and `onnxruntime-node` (already in
  `devDependencies`). If a fresh clone hasn't installed them, run `npm install`
  first.
