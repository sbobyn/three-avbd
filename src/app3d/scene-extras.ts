// The 3D viewer's per-scene panels (../ui/scene-panel.ts): replay and slow motion for the
// smashes, the setting each showcase scene is about (weld strength, ball weight, mass ratio)
// and a live number that shows it working, and the cannonball's size, mass and speed where
// knocking things down is the point. Scenes without an entry get no panel.

import type { SceneOptions } from '../avbd3d/bench-scenes.ts';
import { CUSTOM_3D, CUSTOM_MAX_3D } from '../avbd3d/custom.ts';
import type { SimStats3D } from '../avbd3d/sim.ts';
import { customPanel } from '../ui/custom-panel.ts';
import type { DeviceBudget } from '../ui/device-budget.ts';
import { ICONS } from '../ui/controls.ts';
import { type PanelItem, PANEL_ICONS, type PanelSpec } from '../ui/scene-panel.ts';

export interface ExtrasContext {
  /** Rebuild the scene as it starts (keeping the camera and settings). */
  restart(): void;
  /** Simulated seconds per real second. */
  speed(): number;
  setSpeed(value: number): void;
  /** The scene's options (Scene3D.options); setting one rebuilds the scene. */
  option(key: string): number;
  setOption(key: string, value: number): void;
  /** Set several options and rebuild as if newly chosen (camera and settings reset). */
  apply(options: SceneOptions): void;
  stats(): SimStats3D;
  bodyCount(): number;
  /** What this device can run (null without a GPU). */
  budget(): DeviceBudget | null;
  /** The cannonball Space fires. */
  ball: {
    radius(): number;
    setRadius(value: number): void;
    mass(): number;
    setMass(value: number): void;
    speed(): number;
    setSpeed(value: number): void;
    fire(): void;
  };
}

export const kilograms = (kg: number): string => (kg < 10 ? `${kg.toFixed(1)} kg` : kg < 1000 ? `${kg.toFixed(0)} kg` : `${(kg / 1000).toFixed(kg < 10_000 ? 1 : 0)} t`);

const speed = (ctx: ExtrasContext): PanelItem => ({
  kind: 'choice',
  label: 'Speed',
  options: [
    { label: '1×', value: 1 },
    { label: '½×', value: 0.5 },
    { label: '¼×', value: 0.25 },
  ],
  get: () => ctx.speed(),
  set: (v) => ctx.setSpeed(v),
});

const replay = (ctx: ExtrasContext, label: string): PanelItem => ({ kind: 'action', label, icon: PANEL_ICONS.replay, run: () => ctx.restart() });

const option = (ctx: ExtrasContext, key: string, label: string, options: [string, number][]): PanelItem => ({
  kind: 'choice',
  label,
  options: options.map(([l, value]) => ({ label: l, value })),
  get: () => ctx.option(key),
  set: (v) => ctx.setOption(key, v),
});

const cannonball = (ctx: ExtrasContext): PanelItem[] => [
  { kind: 'range', label: 'Radius', min: 0.2, max: 3, get: ctx.ball.radius, set: ctx.ball.setRadius, format: (v) => `${v.toFixed(2)} m` },
  { kind: 'range', label: 'Mass', min: 1, max: 10_000, log: true, get: ctx.ball.mass, set: ctx.ball.setMass, format: kilograms },
  { kind: 'range', label: 'Launch speed', min: 5, max: 100, get: ctx.ball.speed, set: ctx.ball.setSpeed, format: (v) => `${v.toFixed(0)} m/s` },
  { kind: 'action', label: matchMedia('(hover: none)').matches ? 'Fire' : 'Fire (Space)', icon: ICONS.ball, secondary: true, run: ctx.ball.fire },
];
/** A scene's panel with the cannonball's settings under it. */
const withCannonball = (panel: (ctx: ExtrasContext) => PanelSpec) => (ctx: ExtrasContext) => {
  const spec = panel(ctx);
  return { ...spec, items: [...spec.items, { kind: 'heading', label: 'Cannonball' } as const, ...cannonball(ctx)] };
};
const cannonballOnly = (ctx: ExtrasContext): PanelSpec => ({ title: 'Cannonball', items: cannonball(ctx) });

const smash = withCannonball((ctx) => ({ title: 'Smash', items: [speed(ctx), replay(ctx, 'Replay the smash')] }));

const PANELS: Record<string, (ctx: ExtrasContext) => PanelSpec> = {
  'Brick Ring (28k)': smash,
  'Brick Ring (110k)': smash,
  'Brick Walls (27k)': smash,
  'Wall Smash (2k)': smash,
  'Box Pile (4k)': cannonballOnly,
  'Box Pile (32k)': cannonballOnly,
  'Box Columns (100k)': cannonballOnly,
  Pyramid: cannonballOnly,
  'Breakable Wall (600)': withCannonball((ctx) => ({
    title: 'Welded wall',
    items: [
      option(ctx, 'strength', 'Weld strength', [
        ['Weak', 20],
        ['Normal', 50],
        ['Strong', 150],
      ]),
      { kind: 'readout', label: 'Welds intact', value: () => ctx.stats().joints.toLocaleString('en') },
      speed(ctx),
      replay(ctx, 'Throw again'),
    ],
  })),
  'Chain Mail (1.6k)': (ctx) => ({
    title: 'Chain mail',
    items: [
      option(ctx, 'ballDensity', 'Ball', [
        ['Light', 1],
        ['Heavy', 10],
        ['Massive', 100],
      ]),
      replay(ctx, 'Drop again'),
    ],
  }),
  'Heavy Pendulum': (ctx) => ({
    title: 'Mass ratio',
    items: [
      option(ctx, 'ratio', 'Block : one link', [
        ['1:1', 1],
        ['100:1', 100],
        ['1k:1', 1000],
        ['50k:1', 50000],
      ]),
      { kind: 'readout', label: 'Worst joint stretch', value: () => `${(ctx.stats().maxJointError * 1000).toFixed(1)} mm` },
      replay(ctx, 'Release again'),
    ],
  }),
  'Ragdolls on Cloth (24k)': (ctx) => ({ title: 'Ragdolls', items: [speed(ctx), replay(ctx, 'Drop again')] }),
  'Starry Night (20k)': withCannonball((ctx) => ({ title: 'Starry Night', items: [speed(ctx), replay(ctx, 'Pour it again')] })),
  Custom: withCannonball((ctx) =>
    customPanel('Custom scene', CUSTOM_3D.map((k) => k.name), CUSTOM_MAX_3D, ctx.budget(), {
      current: () => ({ kind: ctx.option('kind'), bodies: ctx.option('bodies') }),
      build: (kind, bodies) => ctx.apply({ kind, bodies }),
      bodyCount: () => ctx.bodyCount(),
    }),
  ),
  Rope: (ctx) => ({
    title: 'Rope',
    items: [
      option(ctx, 'length', 'Length', [
        ['10 m', 10],
        ['20 m', 20],
        ['30 m', 30],
      ]),
      option(ctx, 'links', 'Links', [
        ['10', 10],
        ['20', 20],
        ['40', 40],
        ['80', 80],
      ]),
      option(ctx, 'weight', 'Weight on the end', [
        ['None', 0],
        ['50×', 50],
        ['1000×', 1000],
      ]),
      { kind: 'readout', label: 'Worst joint stretch', value: () => `${(ctx.stats().maxJointError * 1000).toFixed(1)} mm` },
      speed(ctx),
      replay(ctx, 'Drop again'),
    ],
  }),
};

export const panelFor = (scene: string, ctx: ExtrasContext): PanelSpec | null => PANELS[scene]?.(ctx) ?? null;
