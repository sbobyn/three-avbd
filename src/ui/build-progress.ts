// The progress bar shown while a scene builds (both demos). Building is a few long blocking
// stages (the scene on the CPU, the GPU solver's setup, compiling shaders), so the bar can't be
// updated from script mid-stage: instead, before each stage it starts a CSS transition to the
// stage's end over the stage's predicted time, which the browser's compositor keeps running
// while the page's script is busy. Each device learns its own stage rates from its loads.

import type { Dimension } from './scene-menu.ts';

/** Stage time: a fixed part plus a part per body (ms), learned per device. */
interface Rate {
  base: number;
  perBody: number;
}
type Stage = 'build' | 'solver' | 'warm';

/** Starting guesses: an M4 Max's times, doubled (a guess too long only slows the bar). */
const DEFAULTS: Record<Dimension, Record<Stage, Rate>> = {
  '3d': { build: { base: 20, perBody: 0.0015 }, solver: { base: 40, perBody: 0.026 }, warm: { base: 250, perBody: 0.001 } },
  '2d': { build: { base: 20, perBody: 0.004 }, solver: { base: 40, perBody: 0.006 }, warm: { base: 150, perBody: 0.0005 } },
};
const KEY = (dim: Dimension) => `avbd-build-rates-${dim}-v1`;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class BuildProgress {
  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly rates: Record<Stage, Rate>;
  /** The stage under way: when it began and for how many bodies (to learn its rate). */
  private current: { stage: Stage; t0: number; bodies: number } | null = null;

  private readonly dim: Dimension;

  constructor(dim: Dimension) {
    this.dim = dim;
    this.root = document.querySelector<HTMLElement>('#building') ?? document.body.appendChild(document.createElement('div'));
    this.root.id = 'building';
    this.root.className = 'panel build-progress';
    this.root.setAttribute('role', 'progressbar');
    this.root.innerHTML = '<span class="text"></span><div class="track"><div class="fill"></div></div>';
    this.root.hidden = true;
    this.text = this.root.querySelector('.text')!;
    this.fill = this.root.querySelector('.fill')!;
    let saved: Partial<Record<Stage, Rate>> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY(dim)) ?? '{}');
    } catch {
      // Defaults
    }
    this.rates = { ...DEFAULTS[dim], ...saved };
  }

  /** Show the bar, empty. */
  begin(): void {
    this.current = null;
    this.fill.style.transition = 'none';
    this.fill.style.transform = 'scaleX(0)';
    this.root.hidden = false;
    // Apply the reset now, so the first stage's transition starts from empty
    void this.fill.offsetWidth;
  }

  /**
   * Start `stage` (for about `bodies` bodies): the bar heads for `to` (0 to 1) over the stage's
   * predicted time. Resolves once the browser has started the transition, so the caller can
   * then block on the stage's work.
   */
  async stage(stage: Stage, text: string, to: number, bodies: number): Promise<void> {
    this.learn();
    const rate = this.rates[stage];
    const ms = rate.base + rate.perBody * bodies;
    this.text.textContent = text;
    // Ease out: fast at first, then creeping, so a slower stage than predicted still moves
    this.fill.style.transition = `transform ${Math.round(ms * 1.15)}ms cubic-bezier(0.25, 0.7, 0.35, 1)`;
    this.fill.style.transform = `scaleX(${to})`;
    this.root.setAttribute('aria-valuenow', String(Math.round(to * 100)));
    this.current = { stage, t0: performance.now(), bodies };
    await nextFrame();
  }

  /**
   * Show measured progress (`fraction` of the way, 0 to 1): for work that yields as it goes,
   * unlike the blocking stages. Ends the current stage without learning from it.
   */
  set(fraction: number, text: string): void {
    this.current = null;
    this.text.textContent = text;
    this.fill.style.transition = 'transform 150ms linear';
    this.fill.style.transform = `scaleX(${fraction})`;
    this.root.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  /** Hide the bar (the scene is ready, or the load was superseded). */
  done(): void {
    this.learn();
    this.root.hidden = true;
  }

  /** Fold the stage just finished into its rate (scenes big enough for bodies to dominate). */
  private learn(): void {
    if (!this.current) return;
    const { stage, t0, bodies } = this.current;
    this.current = null;
    if (bodies < 10_000) return;
    const ms = performance.now() - t0;
    const rate = this.rates[stage];
    const perBody = Math.max(0, ms - rate.base) / Math.max(bodies, 1);
    // Half the old, half the new: steady, but a new device settles in a load or two
    this.rates[stage] = { base: rate.base, perBody: 0.5 * rate.perBody + 0.5 * perBody };
    try {
      localStorage.setItem(KEY(this.dim), JSON.stringify(this.rates));
    } catch {
      // Not kept
    }
  }
}
