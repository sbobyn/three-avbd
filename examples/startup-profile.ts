// Dev-only browser host for the startup probe (STE-3003, docs/STARTUP_PROFILING.md). Deliberately not a
// Vite build input or gallery entry: serve it from an isolated dev server only. Owns its device and
// renderer; the core (src/comparison/startup-profile.ts) owns the cycle sequence and report rules.
import * as THREE from 'three/webgpu';
import packageText from '../package.json?raw';
import { INTERLOCKING } from '../src/comparison/interlocking-scene.ts';
import { assessAdapter, sanitizeMessage } from '../src/comparison/interlocking-trial.ts';
import {
  instrumentDevice, observeTimerStep, probeSettings, profileSequence, sanitizeLabel, sanitizeResourceName, STARTUP_LIMITS,
  STARTUP_MAX_CYCLES, STARTUP_SCHEMA, statusOf, unavailable, validateStartupReport,
  type DeviceCalls, type Instrumentation, type ProbeModel, type StartupReport, type Unavailable,
} from '../src/comparison/startup-profile.ts';
import type { AvbdPose } from '../src/comparison/interlocking-avbd.ts';
import { DisposableScope } from './interlocking-rapier-lifecycle.ts';
import { releaseRenderer } from './startup.ts';

declare const __COMPARISON_BUILD__: Record<string, unknown>;
const WIDTH = 960, HEIGHT = 540;
const now = () => performance.now();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'), view = element('view'), output = element('report'), download = element<HTMLButtonElement>('download');

const params = new URLSearchParams(location.search);
const label = sanitizeLabel(params.get('label') ?? 'browser');
const instrument = params.get('instrument') !== '0';
const cyclesParam = Number(params.get('cycles') ?? STARTUP_MAX_CYCLES);
const cycles = Number.isInteger(cyclesParam) && cyclesParam >= 1 && cyclesParam <= STARTUP_MAX_CYCLES ? cyclesParam : STARTUP_MAX_CYCLES;
let loadIndexInTab: number | null = null;
try { loadIndexInTab = Number(sessionStorage.getItem('three-avbd:startup-profile:loads') ?? 0) + 1; sessionStorage.setItem('three-avbd:startup-profile:loads', String(loadIndexInTab)); }
catch { loadIndexInTab = null; }
const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
const visibility = { atStart: document.visibilityState as string, changed: false, changes: [] as { at: number; state: string }[] };
document.addEventListener('visibilitychange', () => { visibility.changed = true; visibility.changes.push({ at: now(), state: document.visibilityState }); });

const pkg = JSON.parse(packageText) as { name: string; version: string; devDependencies: Record<string, string> };
const source = { package: { name: pkg.name, version: pkg.version }, git: __COMPARISON_BUILD__,
  declaredDependencies: Object.fromEntries(['three', 'webgpu', 'typescript', 'vite'].map(k => [k, pkg.devDependencies[k] ?? null])) };
const uaData = (navigator as { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean } }).userAgentData;
const environment: Record<string, unknown> = {
  host: 'browser', userAgent: navigator.userAgent,
  userAgentData: uaData ? { brands: uaData.brands?.map(b => ({ brand: b.brand, version: b.version })) ?? [], platform: uaData.platform ?? null, mobile: uaData.mobile ?? null }
    : unavailable('navigator.userAgentData not exposed'),
  runtime: null, platform: null, cpu: null, adapter: unavailable('not acquired'),
  backend: unavailable('browsers do not expose the native backend (Metal/D3D/Vulkan); add an operator note'),
  limits: unavailable('no device'), viewport: unavailable('renderer not initialized'), visibility,
  crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : null,
  observedTimerStepMs: observeTimerStep(now), serving: import.meta.env.DEV ? 'vite-dev' : 'other',
};
const run = { label, navigationType: nav?.type ?? null, loadIndexInTab, orderInSequence: null, operatorNote: params.get('note') ? sanitizeLabel(params.get('note')) : null, cacheState: 'unknown' as const };
const gpuErrors: string[] = [];
let deviceLost: string | null = null;
const timings: Record<string, { value: number } | Unavailable> = {
  adapter: unavailable('not reached'), device: unavailable('not reached'), rendererInit: unavailable('not reached') };
let rendererInitCalls: DeviceCalls | Unavailable = unavailable(instrument ? 'not reached' : 'instrumentation disabled (?instrument=0)');

function navigationRecord() {
  if (!nav) return unavailable('PerformanceNavigationTiming not available');
  return { type: nav.type, responseEnd: nav.responseEnd, domContentLoadedEventEnd: nav.domContentLoadedEventEnd };
}
function assetsRecord() {
  return (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(e => ({
    name: sanitizeResourceName(e.name, location.origin), startTime: e.startTime, duration: e.duration,
    transferSize: e.transferSize, encodedBodySize: e.encodedBodySize }));
}
function report(state: StartupReport['status'], extra: Partial<StartupReport> = {}): StartupReport {
  return { schema: STARTUP_SCHEMA, status: state, diagnostic: true, benchmark: false, observedAt: new Date().toISOString(), source,
    environment: { ...environment, navigation: navigationRecord(), assets: assetsRecord(), acquisitionMs: timings, rendererInitDeviceCalls: rendererInitCalls },
    settings: probeSettings(null, cycles, instrument), run, cycles: [], uncapturedGpuErrors: gpuErrors.map(m => sanitizeMessage(m)), deviceLost,
    instrumentation: { requested: instrument, available: false, reason: instrument ? 'not installed' : 'disabled (?instrument=0)' },
    limits: [...STARTUP_LIMITS, 'Served by a Vite dev server: asset timings are not representative of a production build'], ...extra };
}
function publish(value: StartupReport) {
  const problems = validateStartupReport(value);
  const out = problems.length ? { ...value, status: 'failed' as const, validationProblems: problems } : value;
  (window as { __startupProfile?: unknown }).__startupProfile = out;
  const text = JSON.stringify(out, null, 2);
  output.textContent = text;
  download.disabled = false;
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `startup-profile-${label}-${Date.now()}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return out;
}

const scope = new DisposableScope(error => console.error('Late teardown step failed', error));
let closing = false, running = true;
addEventListener('pagehide', () => { closing = true; if (!running) void scope.dispose(); });
let instrumentation: Instrumentation | null = null;
let pendingReport: StartupReport | undefined;
try {
  if (!navigator.gpu) throw Object.assign(new Error('navigator.gpu unavailable: use a hardware WebGPU browser on localhost'), { refused: true });
  let t = now();
  const adapter = await navigator.gpu.requestAdapter();
  timings.adapter = { value: now() - t };
  if (!adapter) throw Object.assign(new Error('No WebGPU adapter'), { refused: true });
  const info = adapter.info;
  // Accessors read by name: GPUAdapterInfo fields are prototype getters, not own properties
  const assessment = assessAdapter({ vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    isFallbackAdapter: (info as { isFallbackAdapter?: boolean }).isFallbackAdapter }, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
  environment.adapter = assessment.record ?? unavailable('adapter info unavailable');
  if (!assessment.ok) throw Object.assign(new Error(assessment.reason), { refused: true });
  t = now();
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } });
  timings.device = { value: now() - t };
  scope.add(async () => { device.destroy(); await device.lost; }); // World and renderer go first
  device.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
  void device.lost.then(i => { if (i.reason !== 'destroyed') deviceLost = sanitizeMessage(i.message); });
  environment.limits = { maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage };
  if (instrument) { instrumentation = instrumentDevice(device, now); const inst = instrumentation; scope.add(() => inst.restore()); }

  const renderWindow = instrumentation?.window('rendererInit');
  t = now();
  const renderer = new THREE.WebGPURenderer({ antialias: true, device });
  scope.add(() => releaseRenderer(renderer));
  renderer.setPixelRatio(1); renderer.setSize(WIDTH, HEIGHT);
  try { await renderer.init(); } finally { if (renderWindow) rendererInitCalls = renderWindow.end(); }
  timings.rendererInit = { value: now() - t };
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) throw new Error('Three.js WebGL2 fallback refused: the probe requires WebGPU rendering');
  view.append(renderer.domElement);
  scope.add(() => renderer.domElement.remove());
  environment.viewport = { cssWidth: WIDTH, cssHeight: HEIGHT, devicePixelRatio, rendererPixelRatio: renderer.getPixelRatio(),
    canvasWidth: renderer.domElement.width, canvasHeight: renderer.domElement.height };

  // Same scene as examples/interlocking-view.ts: four meshes, two lights, same authored geometry.
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, .1, 100); camera.position.set(5, 4, 7); camera.lookAt(0, 2, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x34435e, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(4, 8, 5); scene.add(light);
  const material = (color: number) => { const m = new THREE.MeshStandardNodeMaterial({ color, roughness: .45 }); scope.add(() => m.dispose()); return m; };
  const geometry = <T extends THREE.BufferGeometry>(g: T) => { scope.add(() => g.dispose()); return g; };
  const floor = new THREE.Mesh(geometry(new THREE.BoxGeometry(...INTERLOCKING.floor.halfExtents.map(v => v * 2))), material(0x283746)); floor.position.set(...INTERLOCKING.floor.position);
  const peg = new THREE.Mesh(geometry(new THREE.CylinderGeometry(INTERLOCKING.peg.radius, INTERLOCKING.peg.radius, INTERLOCKING.peg.halfLength * 2, 24)), material(0x99aabb));
  peg.position.set(...INTERLOCKING.peg.position); peg.rotation.x = Math.PI / 2;
  const shape = geometry(new THREE.TorusGeometry(INTERLOCKING.majorRadius, INTERLOCKING.minorRadius, 16, 96));
  const rings = [new THREE.Mesh(shape, material(0xe0b15b)), new THREE.Mesh(shape, material(0x67bdd5))]; scene.add(floor, peg, ...rings);

  status.textContent = `Running ${cycles} cycle(s), label ${label}${instrument ? '' : ', uninstrumented'}…`;
  let metadata: Record<string, unknown> | null = null;
  const records = await profileSequence(cycles, {
    now, drain: () => device.queue.onSubmittedWorkDone(), instrumentation,
    check: () => { if (closing) throw new Error('Probe page closed'); if (gpuErrors.length) throw new Error(`GPU error: ${gpuErrors[0]}`); if (deviceLost) throw new Error(`Device lost: ${deviceLost}`); },
    importModel: async () => {
      const { createAvbdInterlocking } = await import('../src/comparison/interlocking-avbd.ts');
      return async (): Promise<ProbeModel> => { const m = await createAvbdInterlocking({ device }); metadata ??= { ...m.metadata }; return m; };
    },
    render: {
      call(poses) {
        (poses as AvbdPose[]).forEach((p, i) => { rings[i].position.copy(p.position); rings[i].quaternion.copy(p.rotation); });
        renderer.render(scene, camera);
      },
      nextFrame: () => new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('Probe page closed before next frame'));
        addEventListener('pagehide', abort, { once: true });
        requestAnimationFrame(() => { removeEventListener('pagehide', abort); resolve(); });
      }),
    },
  });
  const state = statusOf(records, cycles, gpuErrors, deviceLost);
  const firstError = records.find(c => c.error)?.error;
  pendingReport = report(state, { settings: probeSettings(metadata, cycles, instrument), cycles: records, ...(firstError ? { error: firstError } : {}),
    instrumentation: { requested: instrument, available: instrumentation?.available ?? false,
      reason: !instrument ? 'disabled (?instrument=0)' : instrumentation && !instrumentation.available ? instrumentation.reason : null } });
} catch (e) {
  const refused = (e as { refused?: boolean }).refused === true;
  pendingReport = report(refused ? 'refused' : 'failed', { error: { phase: refused ? 'adapter' : 'acquire', message: sanitizeMessage(e) } });
} finally {
  // Every model was disposed inside its cycle; then renderer, instrumentation, device (reverse acquisition).
  const errors = await scope.dispose();
  errors.forEach(error => console.error('Teardown step failed', error));
  running = false;
  pendingReport ??= report('failed', { error: { phase: 'acquire', message: 'Probe produced no result' } });
  pendingReport.uncapturedGpuErrors = gpuErrors.map(m => sanitizeMessage(m));
  pendingReport.deviceLost = deviceLost;
  pendingReport.teardownErrors = errors.map(error => sanitizeMessage(error));
  if (errors.length || gpuErrors.length || deviceLost) pendingReport.status = 'failed';
  const out = publish(pendingReport);
  status.textContent = `${out.status}${out.error ? ` in ${out.error.phase}: ${out.error.message}` : ''}${visibility.changed ? ' · tab visibility changed during the run' : ''}. Report in window.__startupProfile.`;
}
