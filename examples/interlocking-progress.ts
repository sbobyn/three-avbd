// The one-line progress readout of the interlocking pages: step, simulated time, paused or live, and a push that has been
// applied but cannot move anything until the simulation steps. DOM-free so Node can test it. The step is the study's own
// count (what its pose readback reports), never a guess from frames drawn, and the line says nothing about speed.

export interface Progress {
  /** Physics steps the study reports having run. */
  readonly step: number;
  /** Fixed timestep of one step in seconds. */
  readonly dt: number;
  readonly paused: boolean;
  /** Pushes applied since the last reset. */
  readonly pushes: number;
  /** A push was applied and no step has run since. */
  readonly pushQueued: boolean;
}

export function progressLine(p: Progress): string {
  const parts = [`step ${p.step} · t = ${(p.step * p.dt).toFixed(2)} s · ${p.paused ? 'paused' : 'live'}`];
  if (p.pushes > 0) parts.push(`${p.pushes} ${p.pushes === 1 ? 'push' : 'pushes'}`);
  // While paused a push changes velocity only: no ring moves until Play steps the simulation.
  if (p.pushQueued && p.paused) parts.push('push queued: the lower ring moves when you press Play');
  return parts.join(' · ');
}

/** Live updates are written at most this often; a change of state (play, pause, push, reset) is written at once. */
export const PROGRESS_MIN_INTERVAL_MS = 250;

/** Whether to write `next` over `shown`. Identical text is never rewritten; live ticks wait out the interval. */
export function shouldWriteProgress(shown: string, next: string, shownAt: number, now: number | undefined): boolean {
  if (next === shown) return false;
  return now === undefined || now - shownAt >= PROGRESS_MIN_INTERVAL_MS;
}
