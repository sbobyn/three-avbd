// The trailer rig's local server (see README.md): serves rig.js and shots.js for the page to
// import, and saves what the page records into clips/ (clips, and the shots' numbers in
// stats.json, merged so re-recording a few shots keeps the others').
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const clips = join(here, 'clips');
mkdirSync(clips, { recursive: true });

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  const script = url.pathname.match(/^\/(rig|shots)\.js$/);
  if (req.method === 'GET' && script) {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(readFileSync(join(here, `${script[1]}.js`)));
  }
  if (req.method !== 'POST' || url.pathname !== '/clip') {
    res.statusCode = 404;
    return res.end();
  }
  const name = (url.searchParams.get('name') ?? 'clip').replace(/[^\w-]/g, '');
  const ext = url.searchParams.get('ext') === 'json' ? 'json' : 'mp4';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const file = join(clips, `${name}.${ext}`);
    let body = Buffer.concat(chunks);
    if (ext === 'json' && url.searchParams.has('merge') && existsSync(file)) {
      const old = JSON.parse(readFileSync(file, 'utf8'));
      const next = JSON.parse(body.toString());
      body = Buffer.from(JSON.stringify({ ...old, ...next, shots: { ...old.shots, ...next.shots } }, null, 2));
    }
    writeFileSync(file, body);
    console.log(`saved clips/${name}.${ext} (${(body.length / 1e6).toFixed(1)} MB)`);
    res.end('ok');
  });
}).listen(8765, '127.0.0.1', () => console.log('trailer rig on http://127.0.0.1:8765 — import rig.js and shots.js from the demo page'));
