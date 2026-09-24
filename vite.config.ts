import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      // The bundles drop licence comments; ship the licence and notices alongside them instead
      name: 'licences',
      generateBundle() {
        for (const fileName of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) this.emitFile({ type: 'asset', fileName, source: readFileSync(fileName, 'utf8') });
      },
    },
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        demo2d: '2d.html',
        bench: 'bench.html',
        bench3d: 'bench3d.html',
        results: 'results.html',
      },
    },
  },
});
