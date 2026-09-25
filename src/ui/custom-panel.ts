// The Custom scenes' panel (both demos): pick a kind of scene and a size, then build. Sizes
// apply on Build only (a rebuild is seconds at the top end, not something a slider should do).

import type { PanelSpec } from './scene-panel.ts';

/** 1,234 → "1.23k", 1,234,567 → "1.23M". */
export const bodies = (n: number): string =>
  n >= 1e6 ? `${Number((n / 1e6).toPrecision(3))}M` : n >= 1e3 ? `${Number((n / 1e3).toPrecision(3))}k` : String(Math.round(n));

export interface CustomContext {
  /** The built scene's kind (an index into `kinds`) and target body count. */
  current(): { kind: number; bodies: number };
  build(kind: number, bodies: number): void;
  bodyCount(): number;
}

export function customPanel(title: string, kinds: string[], max: number, ctx: CustomContext): PanelSpec {
  const pending = { ...ctx.current() };
  return {
    title,
    items: [
      { kind: 'select', label: 'Scene', options: kinds.map((label, value) => ({ label, value })), get: () => pending.kind, set: (v) => (pending.kind = v) },
      { kind: 'range', label: 'Bodies', min: 1000, max, log: true, get: () => pending.bodies, set: (v) => (pending.bodies = Math.round(v)), format: bodies },
      { kind: 'readout', label: 'Built', value: () => `${ctx.bodyCount().toLocaleString('en')} bodies` },
      { kind: 'action', label: 'Build', run: () => ctx.build(pending.kind, pending.bodies) },
    ],
  };
}
