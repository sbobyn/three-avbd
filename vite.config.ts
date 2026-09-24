import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        demo3d: 'index3d.html',
        bench: 'bench.html',
      },
    },
  },
});
