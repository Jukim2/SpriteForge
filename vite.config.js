import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Build with relative paths to prevent asset path breakages on GitHub Pages
  optimizeDeps: {
    // Keep onnxruntime-web out of the dev pre-bundle: its wasm binary must sit
    // next to the JS loader, which is only true for the real node_modules files.
    // vtracer-webapp is excluded for the same reason (its wasm is fetched via
    // ?url next to the glue module).
    exclude: ['onnxruntime-web', 'vtracer-webapp'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  }
});
