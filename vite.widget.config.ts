import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/widget/fidelopass-widget.ts',
      name: 'FidelopassWidget',
      formats: ['iife'],
      fileName: () => 'client.js',
    },
    outDir: 'dist/client/widget/v1',
    emptyOutDir: false,
    minify: 'esbuild',
    sourcemap: true,
  },
});
