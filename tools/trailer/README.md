# Trailer rig

Records the demo's trailer live in Chrome and cuts it with ffmpeg. `rig.js` composites the
WebGPU canvas, the page's panels and labels, and a cursor onto one canvas and records that;
`shots.js` scripts each shot (camera moves, grabs, cannon and wind UI); `build.py` trims and
captions the clips with the numbers measured while recording them.

Needs Chrome with WebGPU, Node, Python 3 and ffmpeg (`brew install ffmpeg`).

## Record

Close other heavy apps and plug in: the captions quote the measured step time, and a busy or
battery-powered machine records slow motion.

1. In the repo: `pnpm install`, then `pnpm dev` (the demo on http://127.0.0.1:5317).
2. In a second terminal: `node tools/trailer/serve.mjs`.
3. Open http://127.0.0.1:5317 in Chrome. Open DevTools, turn on the device toolbar
   (⌘⇧M), choose *Responsive*, and set **1920 × 1080** with DPR **1**. Reload.
4. In the DevTools console:

   ```js
   await import('http://127.0.0.1:8765/rig.js'); await import('http://127.0.0.1:8765/shots.js'); await T.runAll()
   ```

   It takes about two minutes; leave the tab in front. Clips land in `tools/trailer/clips/`.
   The result lists any shot that ran below 60 fps (`slow`).

   - If the 110k ring is slow, record it with the 28k ring instead:
     `await T.runAll({ ring: 'Brick Ring (28k)', only: ['ring'] })`
   - Re-record any one shot the same way, e.g. `await T.runAll({ only: ['flag'] })`.

## Cut

```sh
python3 tools/trailer/build.py --machine "Apple M1 Pro"
```

Writes `tools/trailer/avbd-trailer.mp4` (1080p60, about 28 s). It warns about any shot below
60 fps rather than caption it as real time; `--machine` names the machine in the corner tag.
