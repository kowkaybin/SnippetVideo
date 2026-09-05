/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Plain multi-page Vite build. Output is a flat, unhashed `dist/` folder that
// Chrome can load directly via "Load unpacked".
export default defineConfig({
  root: 'src',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        sw: here('src/background/sw.ts'),
        options: here('src/options.html'),
        library: here('src/library.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['../test/**/*.test.ts'],
  },
});
