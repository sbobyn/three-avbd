import * as THREE from 'three/webgpu';
import { GpuBodies3D, Shape } from '../app3d/gpu-bodies3d.ts';
import { B_POS, B_ROT, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import { createAdapter, type Engine } from './adapters.ts';
import { makeScene } from './scenes.ts';
import { DEFAULTS } from './run.ts';
import { percentile, quality } from './quality.ts';
import { contactQuality } from './contact-quality.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = $<HTMLButtonElement>('run'), download = $<HTMLButtonElement>('download');
let report = '';
let renderer: THREE.WebGPURenderer | undefined;
window.addEventListener('pagehide', () => renderer?.dispose());
button.onclick = async () => {
  button.disabled = true; download.disabled = true; report = '';
  $('output').textContent = ''; $<HTMLTextAreaElement>('raw').value = '';
  $('status').textContent = 'Initializing renderer and physics…';
  let hidden = document.hidden;
  const visibility = () => { hidden ||= document.hidden; };
  document.addEventListener('visibilitychange', visibility);
  try {
    const count = Number($<HTMLInputElement>('frames').value);
    if (!Number.isInteger(count) || count < 30 || count > 600) throw new Error('Frames must be 30–600');
    const rays = Number($<HTMLSelectElement>('rays').value);
    const events = $<HTMLInputElement>('events').checked;
    const readback = $<HTMLInputElement>('readback').checked;
    const manifest = makeScene($<HTMLSelectElement>('case').value);
    renderer ??= new THREE.WebGPURenderer({ canvas: $<HTMLCanvasElement>('view'), antialias: false });
    renderer.setSize(960, 540, false); renderer.setPixelRatio(1);
    $('status').textContent = 'Initializing WebGPU renderer…';
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([renderer.init(), new Promise<never>((_, reject) => {
        initTimer = setTimeout(() => reject(new Error('WebGPU initialization timed out; reopen this page in a fresh tab')), 15000);
      })]);
    } finally { clearTimeout(initTimer); }
    const device = (renderer.backend as unknown as { device: GPUDevice }).device;
    const errors: string[] = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const camera = new THREE.PerspectiveCamera(50, 960 / 540, 0.1, 1000);
    camera.up.set(0, 0, 1); camera.position.set(35, -65, 45); camera.lookAt(0, 0, 4);
    const options = { ...DEFAULTS };
    const results = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const engine of (repeat ? ['avbd', 'rapier'] : ['rapier', 'avbd']) as Engine[]) {
        $('status').textContent = `Building ${engine} world (${manifest.bodies.length} bodies)…`;
        const drawing = new GpuBodies3D(manifest.bodies.length);
        const buffer = drawing.gpuBuffer(renderer);
        const simulation = await createAdapter(engine, manifest, options, device, engine === 'avbd' ? buffer : undefined);
        if (events) simulation.watchContacts!();
        let contactCount = 0, warmupContactCount = 0;
        const eventMs: number[] = [];
        const scene = new THREE.Scene(); scene.background = new THREE.Color(0x222831);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 3)); scene.add(drawing.group);
        const inverse = new Map(simulation.gpuIndices?.map((slot, i) => [slot, i]));
        drawing.setBodies(manifest.bodies.length, slot => {
          const i = inverse.get(slot) ?? slot;
          return i === 0 ? Shape.Floor : manifest.bodies[i].shape === 'sphere' ? Shape.Sphere : Shape.Box;
        }, () => undefined);
        const upload = new Float32Array(manifest.bodies.length * BODY_FLOATS);
        const query = Array.from({ length: rays }, (_, i) => ({ origin: [i % 10 - 5, Math.floor(i / 10) - 5, 30], direction: [0, 0, -1], maxDistance: 100 }));
        const work: number[] = [], intervals: number[] = [], queryMs: number[] = [], readMs: number[] = [];
        let previous = 0;
        try {
          for (let frame = 0; frame < count + 30; frame++) {
            if (hidden) throw new Error('Tab was hidden; rerun with it visible');
            $('status').textContent = `${engine}, repeat ${repeat + 1}, frame ${frame}/${count + 30}`;
            await new Promise<void>((resolve, reject) => {
              const id = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
              const timer = setTimeout(() => { cancelAnimationFrame(id); reject(new Error('Animation frames paused; keep the page visible')); }, 5000);
            });
            if (hidden) throw new Error('Tab was hidden; rerun with it visible');
            if (errors.length) throw new Error(errors.join('; '));
            const start = performance.now();
            simulation.step();
            const readStart = performance.now();
            if (engine === 'rapier' || readback) {
              const state = await simulation.snapshot();
              if (engine === 'rapier') {
                manifest.bodies.forEach((b, i) => {
                  upload.set(state.subarray(i * 13, i * 13 + 3), i * BODY_FLOATS + B_POS);
                  upload.set(state.subarray(i * 13 + 3, i * 13 + 7), i * BODY_FLOATS + B_ROT);
                  upload.set(b.size, i * BODY_FLOATS + B_SIZE);
                });
                device.queue.writeBuffer(buffer, 0, upload);
              }
            }
            const readTime = performance.now() - readStart;
            const queryStart = performance.now();
            if (rays) await simulation.raycasts!(query);
            const queryTime = performance.now() - queryStart;
            const eventStart = performance.now();
            const contacts = events ? await simulation.readContactEvents!() : 0;
            const eventTime = performance.now() - eventStart;
            renderer.render(scene, camera);
            await device.queue.onSubmittedWorkDone();
            if (frame < 30) warmupContactCount += contacts;
            if (frame >= 30) {
              work.push(performance.now() - start); intervals.push(start - previous);
              contactCount += contacts; eventMs.push(eventTime);
              readMs.push(readTime); queryMs.push(queryTime);
            }
            previous = start;
            if (frame % 30 === 0) $('status').textContent = `${engine}, repeat ${repeat + 1}, frame ${frame}/${count + 30}`;
          }
          const snapshot = await simulation.snapshot();
          const counters = await simulation.inspect();
          const finalQuality = quality(manifest, snapshot);
          if (finalQuality.nonFiniteBodies || finalQuality.invalidRotations) throw new Error('Invalid final body state');
          const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
          results.push({ engine, repeat, settings: simulation.settings, workMs: work, frameIntervalMs: intervals,
            meanWorkMs: mean(work), p95WorkMs: percentile(work, 0.95), p95FrameIntervalMs: percentile(intervals, 0.95),
            contactCount, warmupContactCount, meanEventMs: mean(eventMs), meanReadAndUploadMs: mean(readMs), meanQueryMs: mean(queryMs), counters,
            finalQuality, finalContacts: contactQuality(manifest, snapshot) });
        } finally { simulation.destroy(); drawing.dispose(); buffer.destroy(); }
      }
    }
    report = JSON.stringify({ schema: 1, date: new Date().toISOString(), manifest, options, frames: count,
      warmupFrames: 30, rays, readback, events, avbdEventCapacity: manifest.bodies.length * 8, width: 960, height: 540, pixelRatio: 1, adapter: device.adapterInfo,
      userAgent: navigator.userAgent, results,
      limitations: ['Endpoint quality only; use physics harness for per-step validation', 'Frame intervals include display scheduling',
        'Common 160-byte/body render layout is not a separately optimized Rapier renderer', 'No portable peak GPU memory measurement'] }, null, 2);
    $<HTMLTextAreaElement>('raw').value = report;
    $('output').textContent = JSON.stringify(results.map(({ engine, repeat, meanWorkMs, p95WorkMs, p95FrameIntervalMs, meanEventMs, contactCount, meanReadAndUploadMs, meanQueryMs }) =>
      ({ engine, repeat, meanWorkMs, p95WorkMs, p95FrameIntervalMs, meanEventMs, contactCount, meanReadAndUploadMs, meanQueryMs })), null, 2);
    $('status').textContent = 'Completed; inspect endpoint quality before comparing speed.';
    download.disabled = false;
  } catch (e) { $('status').textContent = String(e); }
  finally { document.removeEventListener('visibilitychange', visibility); button.disabled = false; }
};
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'rendered-comparison.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
