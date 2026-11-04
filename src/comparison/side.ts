// Side-by-side live view (compare-side.html): the same comparison scene in Rapier (left, WASM on
// the CPU) and AVBD (right, WebGPU), stepped once per animation frame with the same dt. Uses the
// harness adapters and the rendering shared with compare-frame.html; this is a demo, not a benchmark.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAdapter, type Adapter, type Engine } from './adapters.ts';
import { contactQuality } from './contact-quality.ts';
import { REST_SPEED, restFraction } from './final-window.ts';
import { quality } from './quality.ts';
import { DEFAULTS } from './run.ts';
import { makeScene, SCENE_VALIDITY, type CaseName, type Scene } from './scenes.ts';
import { familyOf, familyValidity, formatSettings, MARGINS, parseSettings, RollingStats, sceneFamilies, validity,
  type Family, type SideSettings } from './side-model.ts';
import { BodyView, initRenderer } from './view.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
const families = sceneFamilies();
let settings: SideSettings = parseSettings(location.search);
/** Above this many bodies the body–body overlap check (sweep and prune) is skipped. */
const CONTACT_CHECK_LIMIT = 12_000;
/** Seconds between quality readbacks while running (AVBD's needs a full body readback). */
const QUALITY_INTERVAL_MS = 1000;

interface Side {
  engine: Engine;
  renderer: THREE.WebGPURenderer;
  device: GPUDevice;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  view?: BodyView;
  sim?: Adapter;
  /** Rapier: world.step() wall time. AVBD: CPU encode + submit of one step. */
  submit: RollingStats;
  /** AVBD only: submit start until queue.onSubmittedWorkDone() resolves (queue drained first). */
  completed: RollingStats;
  errors: string[];
  quality: string;
  awake: string;
}

let manifest: Scene | undefined;
let steps = 0;
let lastQuality = 0;
let stepRequests = 0;
let fittedScene = '';

// ---- Controls -------------------------------------------------------------------------------
const sceneSelect = $<HTMLSelectElement>('scene'), scaleSelect = $<HTMLSelectElement>('scale');
const pauseButton = $<HTMLButtonElement>('pause');
const groups: Record<ReturnType<typeof familyValidity>, string> = {
  valid: 'Valid resting / pile scenes', unclassified: 'Dynamics scenes (no resting claim)', invalid: 'Not valid for resting claims',
};
for (const kind of ['valid', 'unclassified', 'invalid'] as const) {
  const group = document.createElement('optgroup');
  group.label = groups[kind];
  for (const f of families.filter(f => familyValidity(f) === kind)) {
    const option = new Option(kind === 'invalid' ? `✗ ${f.label} (${validity(f.members[0].name).note})` : f.label, f.id);
    group.append(option);
  }
  sceneSelect.append(group);
}
const heavy = (name: CaseName) => nominalBodies(name) > 20_000;
/** The count in a scaled case's name (ring-110k → 110000); 0 for impact ratios and unscaled cases. */
function nominalBodies(name: CaseName): number {
  const m = /-(\d+)(k?)(-settled)?$/.exec(name);
  return m && !name.startsWith('impact-') ? Number(m[1]) * (m[2] ? 1000 : 1) : 0;
}
function fillScale(f: Family): void {
  scaleSelect.replaceChildren(...f.members.map(m => {
    const v = validity(m.name);
    const text = `${m.scale || '—'}${v.kind === 'invalid' ? ` ✗ ${v.note}` : ''}${heavy(m.name) ? ' (heavy)' : ''}`;
    return new Option(text, m.name);
  }));
  scaleSelect.disabled = f.members.length < 2;
  $('scale-label').firstChild!.textContent = `${f.scaleLabel} `;
}
function syncControls(): void {
  const f = familyOf(settings.scene, families);
  sceneSelect.value = f.id;
  fillScale(f);
  scaleSelect.value = settings.scene;
  $<HTMLInputElement>('avbd-iterations').value = String(settings.avbdIterations);
  $<HTMLInputElement>('rapier-iterations').value = String(settings.rapierIterations);
  $<HTMLSelectElement>('margin').value = String(settings.avbdMargin);
  $<HTMLInputElement>('sleep').checked = settings.rapierSleeping;
  $<HTMLInputElement>('link').checked = settings.linkCameras;
  pauseButton.textContent = settings.paused ? 'Play' : 'Pause';
  const v = validity(settings.scene), entry = SCENE_VALIDITY[settings.scene];
  $('validity').textContent = `${settings.scene}: ${v.kind === 'unclassified' ? v.note : `${v.note} (${entry!.kind} scene)`}` +
    (entry?.lead ? `. The harness measures it after ${entry.lead} lead-in steps; this view starts at step 0.` : '.');
  $('validity').className = v.kind;
}
for (const m of MARGINS) $<HTMLSelectElement>('margin').append(new Option(`${m} m${m === DEFAULTS.avbdMargin ? ' (default)' : ''}`, String(m)));

function update(change: Partial<SideSettings>, rebuild: boolean): void {
  settings = { ...settings, ...change };
  history.replaceState(null, '', `${location.pathname}${formatSettings(settings)}`);
  syncControls();
  if (rebuild) void serial(build);
}
sceneSelect.onchange = () => {
  const f = families.find(f => f.id === sceneSelect.value)!;
  const current = familyOf(settings.scene, families).members.find(m => m.name === settings.scene)?.scale;
  const pick = f.members.find(m => m.scale === current) ?? f.members.find(m => validity(m.name).kind === 'valid') ?? f.members[0];
  update({ scene: pick.name }, true);
};
scaleSelect.onchange = () => update({ scene: scaleSelect.value as CaseName }, true);
const iterations = (id: string, fallback: number) => {
  const n = Number($<HTMLInputElement>(id).value);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : fallback;
};
$('avbd-iterations').onchange = () => update({ avbdIterations: iterations('avbd-iterations', settings.avbdIterations) }, true);
$('rapier-iterations').onchange = () => update({ rapierIterations: iterations('rapier-iterations', settings.rapierIterations) }, true);
$('margin').onchange = () => update({ avbdMargin: Number($<HTMLSelectElement>('margin').value) }, true);
$('sleep').onchange = () => update({ rapierSleeping: $<HTMLInputElement>('sleep').checked }, true);
$('link').onchange = () => { update({ linkCameras: $<HTMLInputElement>('link').checked }, false); if (settings.linkCameras) syncCamera(sides[0], sides[1]); };
pauseButton.onclick = () => update({ paused: !settings.paused }, false);
$('step').onclick = () => { if (!settings.paused) update({ paused: true }, false); stepRequests++; };
$('reset').onclick = () => void serial(build);
$('defaults').onclick = () => update({ avbdIterations: DEFAULTS.avbdIterations, rapierIterations: DEFAULTS.rapierIterations,
  avbdMargin: DEFAULTS.avbdMargin, rapierSleeping: DEFAULTS.rapierSleeping }, true);
syncControls();

// ---- Work queue: building, stepping and readbacks never overlap -------------------------------
let work: Promise<void> = Promise.resolve();
let pending = 0;
function serial(task: () => Promise<void>): Promise<void> {
  pending++;
  work = work.then(task).catch((e: unknown) => { status.textContent = String(e); settings = { ...settings, paused: true }; syncControls(); })
    .finally(() => { pending--; });
  return work;
}

// ---- Renderers and the shared camera -------------------------------------------------------
let sides: Side[] = [];
let syncing = false;
function syncCamera(from: Side, to: Side): void {
  syncing = true;
  to.camera.position.copy(from.camera.position);
  to.controls.target.copy(from.controls.target);
  to.controls.update();
  syncing = false;
}
async function makeSide(engine: Engine): Promise<Side> {
  const canvas = $<HTMLCanvasElement>(engine);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  const device = await initRenderer(renderer);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  const side: Side = { engine, renderer, device, camera, controls, submit: new RollingStats(), completed: new RollingStats(),
    errors: [], quality: '—', awake: '' };
  device.addEventListener('uncapturederror', e => side.errors.push(e.error.message));
  return side;
}
function resize(): void {
  for (const s of sides) {
    const canvas = s.renderer.domElement, width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) continue;
    s.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    s.renderer.setSize(width, height, false);
    s.camera.aspect = width / height;
    s.camera.updateProjectionMatrix();
  }
}
/** Frame the dynamic bodies and the ground point under them; kept across resets of one scene. */
function fit(scene: Scene): void {
  const box = new THREE.Box3().expandByPoint(new THREE.Vector3(scene.bodies[0].position[0], scene.bodies[0].position[1], scene.groundTop));
  for (const b of scene.bodies.slice(1)) box.expandByPoint(new THREE.Vector3(...b.position as [number, number, number]));
  const center = box.getCenter(new THREE.Vector3()), radius = Math.max(4, box.getSize(new THREE.Vector3()).length() / 2 + 2);
  const direction = new THREE.Vector3(0.45, -0.8, 0.5).normalize();
  for (const s of sides) {
    s.controls.target.copy(center);
    s.camera.position.copy(center).addScaledVector(direction, radius / Math.tan(THREE.MathUtils.degToRad(25)) * 0.9);
    s.camera.far = Math.max(2000, radius * 20);
    s.camera.updateProjectionMatrix();
    s.controls.update();
  }
}

// ---- Build, step, measure ----------------------------------------------------------------
const config = () => ({ ...DEFAULTS, dt: settings.dt, avbdIterations: settings.avbdIterations, rapierIterations: settings.rapierIterations,
  avbdMargin: settings.avbdMargin, rapierSleeping: settings.rapierSleeping });
async function build(): Promise<void> {
  for (const s of sides) { s.sim?.destroy(); s.view?.dispose(); s.sim = s.view = undefined; }
  manifest = makeScene(settings.scene);
  status.textContent = `Building ${settings.scene} (${manifest.bodies.length} bodies)…`;
  for (const s of sides) {
    s.submit.clear(); s.completed.clear(); s.errors.length = 0; s.quality = '—'; s.awake = '';
    s.view = new BodyView(s.renderer, manifest);
    s.sim = await createAdapter(s.engine, manifest, config(), s.device, s.engine === 'avbd' ? s.view.buffer : undefined);
    s.view.bind(s.sim);
    if (s.engine === 'rapier') s.view.writePoses(s.device, await s.sim.snapshot());
    await s.sim.complete();
  }
  if (fittedScene !== settings.scene) { fit(manifest); fittedScene = settings.scene; }
  steps = 0; lastQuality = 0;
  await measureQuality();
  status.textContent = `${settings.scene}: ${manifest.bodies.length - 1} bodies + ground, dt ${(settings.dt * 1000).toFixed(2)} ms`;
}
async function stepBoth(): Promise<void> {
  for (const s of sides) {
    const sim = s.sim!;
    if (s.engine === 'rapier') {
      const t = performance.now();
      sim.step();
      s.submit.push(performance.now() - t);
      s.view!.writePoses(s.device, await sim.snapshot());
    } else {
      // Drain the previous frame's render so the completed time covers this step only.
      await sim.complete();
      const t0 = performance.now();
      sim.step();
      const t1 = performance.now();
      await sim.complete();
      s.submit.push(t1 - t0); s.completed.push(performance.now() - t0);
    }
  }
  steps++;
}
const mm = (m: number) => `${(m * 1000).toFixed(m < 0.01 ? 2 : 1)} mm`;
async function measureQuality(): Promise<void> {
  for (const s of sides) {
    try {
      const state = await s.sim!.snapshot();
      const q = quality(manifest!, state);
      if (q.nonFiniteBodies || q.invalidRotations) { s.quality = `✗ ${q.nonFiniteBodies} non-finite, ${q.invalidRotations} invalid rotations`; continue; }
      const contacts = manifest!.bodies.length <= CONTACT_CHECK_LIMIT ? contactQuality(manifest!, state) : undefined;
      s.quality = `floor ${mm(q.maxFloorPenetration)}${q.outsideFloorBodies ? ` (${q.outsideFloorBodies} off floor)` : ''}` +
        ` · body–body ${contacts ? mm(contacts.maxDepth) : contacts === null ? '✗' : 'skipped (>12k)'}` +
        ` · max speed ${q.maxSpeed.toFixed(3)} m/s · ${(100 * restFraction(manifest!, state)).toFixed(1)}% at rest (< ${REST_SPEED * 100} cm/s)`;
      const counters = await s.sim!.inspect() as { activeBodies?: number };
      s.awake = counters.activeBodies === undefined ? '' : ` · ${counters.activeBodies} awake`;
    } catch (e) { s.quality = `✗ ${escape(e instanceof Error ? e.message : String(e))}`; }
  }
  lastQuality = performance.now();
}

// ---- Panels --------------------------------------------------------------------------------
const escape = (text: string) => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const ms = (v: number) => Number.isFinite(v) ? v.toFixed(v < 1 ? 3 : 2) : '—';
function settingsText(s: Side): string {
  if (s.engine === 'rapier') {
    const r = s.sim?.settings as { version?: string } | undefined;
    return `Rapier ${r?.version ?? ''} (rapier3d-compat, WASM) · ${settings.rapierIterations} solver iterations` +
      `${settings.rapierIterations === DEFAULTS.rapierIterations ? ' (default)' : ''}, ${DEFAULTS.rapierPgsIterations} internal PGS` +
      ` · sleeping ${settings.rapierSleeping ? 'on' : 'off (default)'} · CCD off · restitution 0`;
  }
  return `three-avbd GpuSolver3D (WebGPU) · ${settings.avbdIterations} iterations` +
    `${settings.avbdIterations === DEFAULTS.avbdIterations ? ' (harness default)' : ''}` +
    ` · margin ${settings.avbdMargin} m${settings.avbdMargin === DEFAULTS.avbdMargin ? ' (default)' : ''} · no sleeping`;
}
function renderPanel(s: Side): void {
  const panel = $(`${s.engine}-panel`);
  const dynamic = manifest?.bodies.filter(b => b.mass > 0).length ?? 0;
  const timing = s.engine === 'rapier'
    ? `<b>${ms(s.submit.mean)}</b> ms/step mean · ${ms(s.submit.p95)} p95 <span class="muted">(world.step, CPU)</span>`
    : `<b>${ms(s.completed.mean)}</b> ms/step mean · ${ms(s.completed.p95)} p95 <span class="muted">(submit → GPU completed)</span><br>` +
      `${ms(s.submit.mean)} mean · ${ms(s.submit.p95)} p95 <span class="muted">(CPU encode + submit only)</span>`;
  panel.innerHTML = `${timing}<br><span class="muted">window: last ${s.submit.count} of ${s.submit.size} steps</span><br>` +
    `${dynamic} dynamic bodies (${manifest?.bodies.length ?? 0} total)${s.awake}<br>` +
    `Max penetration / speed: ${s.quality}<br><span class="muted">${settingsText(s)}</span>` +
    (s.errors.length ? `<br><span class="bad">GPU error: ${escape(s.errors[0])}</span>` : '');
}

// ---- Main loop -----------------------------------------------------------------------------
async function tick(): Promise<void> {
  if (!manifest || !sides.every(s => s.sim)) return;
  const stepping = !settings.paused || stepRequests > 0;
  if (stepping) {
    if (settings.paused) stepRequests--;
    await stepBoth();
    if (settings.paused || performance.now() - lastQuality > QUALITY_INTERVAL_MS) await measureQuality();
  }
  for (const s of sides) s.renderer.render(s.view!.scene, s.camera);
  $('steps').textContent = `step ${steps} · t = ${(steps * settings.dt).toFixed(2)} s${settings.paused ? ' · paused' : ''}`;
  for (const s of sides) renderPanel(s);
}
function loop(): void {
  if (pending === 0) void serial(tick);
  requestAnimationFrame(loop);
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error('This page needs WebGPU (recent Chrome or Edge, or Safari 26+)');
  status.textContent = 'Initializing WebGPU renderers…';
  sides = [await makeSide('rapier'), await makeSide('avbd')];
  for (const [i, s] of sides.entries()) {
    s.controls.addEventListener('change', () => { if (settings.linkCameras && !syncing) syncCamera(s, sides[1 - i]); });
  }
  new ResizeObserver(resize).observe($('views'));
  resize();
  window.addEventListener('pagehide', () => { for (const s of sides) { s.sim?.destroy(); s.view?.dispose(); s.renderer.dispose(); } });
  await serial(build);
  requestAnimationFrame(loop);
}
start().catch((e: unknown) => { status.textContent = String(e); });
