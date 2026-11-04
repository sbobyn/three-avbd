// DOM-free pieces of the side-by-side page (compare-side.html): scene families with a
// body-count/scale choice, validity labels, URL settings and a rolling timing window.
import { DEFAULTS } from './run.ts';
import { CASES, SCENE_VALIDITY, type CaseName } from './scenes.ts';

/** A scene family: cases that differ only in count or scale, e.g. rest-grid-100/1k/10k. */
export interface Family { id: string; label: string; scaleLabel: string; members: { scale: string; name: CaseName }[]; }

const SCALED = /^(.*)-(\d+k?)(-settled)?$/;
/** Group `CASES` into families; single-case scenes are one-member families. Order follows `CASES`. */
export function sceneFamilies(): Family[] {
  const families = new Map<string, Family>();
  for (const name of CASES) {
    const m = SCALED.exec(name);
    // Names whose number is part of a fixed scene (sphere-pile-100, its HCP variant, stack-50,
    // chain-20) have no siblings; they still end up as one-member families.
    const id = m ? `${m[1]}-N${m[3] ?? ''}` : name;
    const scale = m ? m[2] : '';
    const family = families.get(id) ?? { id, label: id, scaleLabel: id.startsWith('impact-') ? 'Mass ratio' : 'Bodies', members: [] };
    family.members.push({ scale, name });
    families.set(id, family);
  }
  for (const f of families.values()) if (f.members.length === 1) { f.id = f.label = f.members[0].name; f.members[0].scale = ''; }
  return [...families.values()];
}
export function familyOf(name: CaseName, families = sceneFamilies()): Family {
  const family = families.find(f => f.members.some(m => m.name === name));
  if (!family) throw new Error(`Unknown case ${name}`);
  return family;
}

export type Validity = 'valid' | 'invalid' | 'unclassified';
/** `valid`/`invalid` for resting and pile scenes per SCENE_VALIDITY; dynamics scenes are unclassified. */
export function validity(name: CaseName): { kind: Validity; note: string } {
  const v = SCENE_VALIDITY[name];
  if (!v) return { kind: 'unclassified', note: 'dynamics scene; no resting claim' };
  return v.status === 'valid' ? { kind: 'valid', note: 'valid' } : { kind: 'invalid', note: v.status };
}
export function familyValidity(f: Family): Validity {
  const kinds = f.members.map(m => validity(m.name).kind);
  return kinds.includes('valid') ? 'valid' : kinds.includes('invalid') ? 'invalid' : 'unclassified';
}

export interface SideSettings {
  scene: CaseName; dt: number; avbdIterations: number; rapierIterations: number;
  avbdMargin: number; rapierSleeping: boolean; linkCameras: boolean; paused: boolean;
}
export const SIDE_DEFAULTS: SideSettings = {
  scene: 'pile-1k-settled', dt: DEFAULTS.dt, avbdIterations: DEFAULTS.avbdIterations, rapierIterations: DEFAULTS.rapierIterations,
  avbdMargin: DEFAULTS.avbdMargin, rapierSleeping: DEFAULTS.rapierSleeping, linkCameras: true, paused: false,
};
export const MARGINS = [0.01, 0.001] as const;

const flag = (v: string | null, fallback: boolean) => v === null ? fallback : v === '1' || v === 'true' || v === 'on';
const positiveInt = (v: string | null, fallback: number) => {
  const n = Number(v);
  return v !== null && Number.isInteger(n) && n >= 1 && n <= 64 ? n : fallback;
};
/** Settings from a query string; unknown or invalid values fall back to the defaults. */
export function parseSettings(query: string): SideSettings {
  const q = new URLSearchParams(query), d = SIDE_DEFAULTS;
  const scene = q.get('scene');
  const margin = Number(q.get('margin'));
  const dt = Number(q.get('dt'));
  return {
    scene: (CASES as readonly string[]).includes(scene ?? '') ? scene as CaseName : d.scene,
    dt: q.get('dt') !== null && Number.isFinite(dt) && dt > 0 && dt <= 0.1 ? dt : d.dt,
    avbdIterations: positiveInt(q.get('avbdIterations'), d.avbdIterations),
    rapierIterations: positiveInt(q.get('rapierIterations'), d.rapierIterations),
    avbdMargin: (MARGINS as readonly number[]).includes(margin) ? margin : d.avbdMargin,
    rapierSleeping: flag(q.get('sleep'), d.rapierSleeping),
    linkCameras: flag(q.get('link'), d.linkCameras),
    paused: flag(q.get('paused'), d.paused),
  };
}
/** The query string for `s`, listing only values that differ from the defaults. */
export function formatSettings(s: SideSettings): string {
  const q = new URLSearchParams(), d = SIDE_DEFAULTS;
  if (s.scene !== d.scene) q.set('scene', s.scene);
  if (s.dt !== d.dt) q.set('dt', String(s.dt));
  if (s.avbdIterations !== d.avbdIterations) q.set('avbdIterations', String(s.avbdIterations));
  if (s.rapierIterations !== d.rapierIterations) q.set('rapierIterations', String(s.rapierIterations));
  if (s.avbdMargin !== d.avbdMargin) q.set('margin', String(s.avbdMargin));
  if (s.rapierSleeping !== d.rapierSleeping) q.set('sleep', s.rapierSleeping ? '1' : '0');
  if (s.linkCameras !== d.linkCameras) q.set('link', s.linkCameras ? '1' : '0');
  if (s.paused !== d.paused) q.set('paused', s.paused ? '1' : '0');
  const text = q.toString();
  return text ? `?${text}` : '';
}

/** Mean and p95 over the last `size` samples. */
export class RollingStats {
  private readonly values: number[] = [];
  readonly size: number;
  constructor(size = 120) { this.size = size; }
  push(v: number): void { this.values.push(v); if (this.values.length > this.size) this.values.shift(); }
  clear(): void { this.values.length = 0; }
  get count(): number { return this.values.length; }
  get mean(): number { return this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : NaN; }
  get p95(): number {
    if (!this.values.length) return NaN;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
  }
}
