import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gitProvenance } from './scripts/git-provenance.ts';

export default defineConfig({
  define: {
    // Source archives have no Git metadata: the report records unknown provenance instead of failing
    __COMPARISON_BUILD__: JSON.stringify(gitProvenance(fileURLToPath(new URL('.', import.meta.url)))),
  },
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
        sdf: 'sdf.html',
        sdfGears: 'sdf-gears.html',
        sdfReleased: 'sdf-released.html',
        demo2d: '2d.html',
        bench: 'bench.html',
        bench3d: 'bench3d.html',
        comparison: 'compare.html',
        comparisonFrame: 'compare-frame.html',
        comparisonSide: 'compare-side.html',
        results: 'results.html',
      },
    },
  },
});
