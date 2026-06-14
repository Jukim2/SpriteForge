import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Build with relative paths to prevent asset path breakages on GitHub Pages
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
});
