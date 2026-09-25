// Device calibration, shared by both demos: on a device's first visit, time a few solver steps
// of a small scene off screen and turn that into body budgets. The demos use them to pick a
// landing scene the device can run, mark scenes that will be slow, ask before loading one far
// past what the device can do (a GPU that stalls for seconds can be reset by the OS, taking
// the page down with it), and cap the Custom sizes. Cached per GPU in localStorage.

import type { Dimension } from './scene-menu.ts';

export interface DeviceBudget {
  /** Bodies this device steps within REALTIME_MS: the scene runs in real time. */
  realtime: number;
  /** Bodies it steps within LIMIT_MS: slow motion but responsive. Past this, ask first. */
  limit: number;
  /** The measurement behind them: ms per step for `probeBodies` bodies. */
  probeMs: number;
  probeBodies: number;
  /** The adapter it was measured on (a different GPU measures again). */
  gpu: string;
}

/** A step's share of a 60 Hz frame (16.7 ms), leaving the rest for rendering. */
const REALTIME_MS = 12;
/** A step this long gives about 8 frames a second: still usable, and far from an OS GPU reset. */
const LIMIT_MS = 120;
const KEY = (dim: Dimension) => `avbd-device-budget-${dim}-v1`;

/**
 * ms per call of `step` (which queues GPU work) once warm: the fastest of three timed runs, the
 * one least disturbed by whatever else the machine is doing.
 */
export async function timeSteps(device: GPUDevice, step: () => void): Promise<number> {
  const run = async (steps: number) => {
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) step();
    await device.queue.onSubmittedWorkDone();
    return (performance.now() - t0) / steps;
  };
  await run(3);
  return Math.min(await run(8), await run(8), await run(8));
}

/** Describe the adapter, to tell GPUs apart in the cache. */
export const adapterName = (adapter: GPUAdapter | null): string =>
  adapter?.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description].filter(Boolean).join(' · ') : 'unknown';

const load = (dim: Dimension): DeviceBudget | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY(dim)) ?? 'null');
  } catch {
    return null;
  }
};
const save = (dim: Dimension, budget: DeviceBudget): void => {
  try {
    localStorage.setItem(KEY(dim), JSON.stringify(budget));
  } catch {
    // Private windows: calibrate again next time
  }
};

/**
 * The device's budgets for demo `dim`: cached, or measured with `probe(bodies)` (ms per step
 * for a scene of about that many bodies). A small probe first, then larger ones while it
 * stays fast: per-step overhead dominates a small scene on a big GPU and would understate it.
 * The probe scene should cost per body what the demo's heavy scenes do (a settled pyramid, say,
 * is several times cheaper than a joint lattice or a box rain).
 */
export async function deviceBudget(dim: Dimension, gpu: string, probe: (bodies: number) => Promise<number>, sizes: number[]): Promise<DeviceBudget> {
  const cached = load(dim);
  if (cached && cached.gpu === gpu) return cached;
  const notice = document.createElement('div');
  notice.className = 'panel calibrating';
  notice.textContent = 'Measuring this GPU…';
  document.body.append(notice);
  let [bodies, ms] = [sizes[0], await probe(sizes[0])];
  for (const size of sizes.slice(1)) {
    if (ms >= 4) break;
    [bodies, ms] = [size, await probe(size)];
  }
  notice.remove();
  // Cost grows about linearly with bodies (per-step overhead makes this conservative)
  ms = Math.max(ms, 0.05);
  const perBody = ms / bodies;
  const budget = { realtime: Math.floor(REALTIME_MS / perBody), limit: Math.floor(LIMIT_MS / perBody), probeMs: ms, probeBodies: bodies, gpu };
  save(dim, budget);
  return budget;
}

/** After a GPU reset: halve the budgets, so the next visit stays further from the edge. */
export function lowerBudget(dim: Dimension): void {
  const b = load(dim);
  if (b) save(dim, { ...b, realtime: Math.floor(b.realtime / 2), limit: Math.floor(b.limit / 2) });
}

/** Measure again on the next load. */
export function forgetBudget(dim: Dimension): void {
  try {
    localStorage.removeItem(KEY(dim));
  } catch {
    // Nothing stored
  }
}

/** A scene's body count from its name ("Brick Ring (110k)" → 110,000); 0 for the small ones. */
export function bodiesInName(name: string): number {
  const m = /\((\d+(?:\.\d+)?)k\)/.exec(name);
  return m ? Math.round(Number(m[1]) * 1000) : 0;
}

/** Predicted ms per step for `bodies` bodies on this device. */
export const stepMs = (budget: DeviceBudget, bodies: number): number => (budget.probeMs * bodies) / budget.probeBodies;

/** A menu note for a scene of `bodies`: nothing, "slow here", or "too heavy here". */
export function heaviness(budget: DeviceBudget | null, bodies: number): string | undefined {
  if (!budget || bodies <= budget.realtime) return undefined;
  return bodies <= budget.limit ? 'slow here' : 'too heavy here';
}

/**
 * Whether to go ahead with a scene of `bodies` bodies: past the limit, ask (a few seconds a
 * step can get the GPU reset).
 */
export function confirmHeavy(budget: DeviceBudget | null, name: string, bodies: number): boolean {
  if (!budget || bodies <= budget.limit) return true;
  const ms = stepMs(budget, bodies);
  const rate = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  return confirm(
    `${name} is too heavy for this device: about ${rate} a step (it runs ${bodies.toLocaleString('en')} bodies; ` +
      `this GPU keeps about ${budget.realtime.toLocaleString('en')} in real time).\n\n` +
      'Heavy scenes can freeze the browser, or make the system reset the GPU. Load it anyway?',
  );
}

/**
 * Tell the user when the GPU is lost (a driver reset, usually from a scene too heavy for it)
 * instead of leaving a frozen canvas, and lower the budgets for next time.
 */
export function watchDeviceLoss(dim: Dimension, device: GPUDevice, scene: () => string): void {
  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    lowerBudget(dim);
    const panel = document.createElement('div');
    panel.className = 'panel gpu-lost';
    panel.innerHTML =
      '<strong>The GPU stopped responding</strong><p></p><button type="button">Reload</button>';
    panel.querySelector('p')!.textContent =
      `It was running ${scene()}, which may be too heavy for this device. Reload to continue: this device's limits are now set lower.`;
    panel.querySelector('button')!.addEventListener('click', () => location.reload());
    document.body.append(panel);
  });
}
