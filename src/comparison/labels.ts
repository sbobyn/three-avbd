// Human-readable names for the comparison cases, shared by compare-side.html and compare.html (and anything
// else that must not print a raw case ID). DOM-free and engine-free: it imports only a type, so a page that
// cannot load solvers (the demo gallery) may import it too. The case IDs themselves, URLs (?scene=) and the JSON
// report identity are unchanged: a label is only ever shown next to or instead of an ID, never used as one.
import type { CaseName } from './scenes.ts';

export interface CaseInfo {
  /** Short name, the same wording as the demo gallery's comparison chips. */
  readonly label: string;
  /** Dynamic (non-fixed) bodies in the scene, excluding the ground and fixed walls; checked against `makeScene`. */
  readonly bodies: number;
  /** One sentence on what is simulated. */
  readonly summary: string;
}

export const CASE_INFO: Readonly<Record<CaseName, CaseInfo>> = {
  'impact-train': { label: 'Impact train', bodies: 105, summary: 'A pile of 100 randomly sized boxes struck by 5 spheres moving at 10 m/s.' },
  'free-fall': { label: 'Free fall', bodies: 1, summary: 'One box dropped from 100 m onto the ground.' },
  slide: { label: 'Slide', bodies: 1, summary: 'One box sliding along the ground at 5 m/s.' },
  spin: { label: 'Spin', bodies: 1, summary: 'One box spinning at 2 rad/s about the vertical axis, with gravity off.' },
  'rest-grid-100': { label: 'Resting grid · 100', bodies: 100, summary: '100 unit boxes resting in columns of 10.' },
  'rest-grid-1k': { label: 'Resting grid · 1k', bodies: 1000, summary: '1,000 unit boxes resting in columns of 10.' },
  'rest-grid-10k': { label: 'Resting grid · 10k', bodies: 10000, summary: '10,000 unit boxes resting in columns of 10.' },
  'stack-50': { label: 'Stack of 50', bodies: 50, summary: '50 unit boxes stacked in one column.' },
  'stack-heavy': { label: 'Heavy stack', bodies: 10, summary: '10 unit boxes stacked in one column; the top box is 1000 times heavier than the others.' },
  'chain-20': { label: 'Chain of 20', bodies: 20, summary: '20 slender links hung from a fixed anchor by ball joints.' },
  'chain-heavy': { label: 'Heavy chain', bodies: 20, summary: '20 slender links hung from a fixed anchor by ball joints; the last link is 1000 times heavier than the others.' },
  'sphere-pile-100': { label: 'Sphere pile', bodies: 100, summary: '100 spheres in 25 single-file columns of 4, an unstable equilibrium.' },
  'sphere-pile-hcp-100': { label: 'Sphere pile, packed', bodies: 100, summary: '100 spheres close-packed in 4 layers and held by 3 fixed walls.' },
  'impact-graze': { label: 'Grazing impact', bodies: 1, summary: 'A small sphere at 240 m/s passing a fixed box with 1 cm of clearance, with gravity off.' },
  'impact-rotate': { label: 'Rotating impact', bodies: 2, summary: 'A spinning blade sweeps toward a stationary sphere, with gravity off.' },
  'impact-1': { label: 'Impact · mass ratio 1', bodies: 2, summary: 'A sphere with the same mass as the brick it hits at 30 m/s, with gravity off.' },
  'impact-100': { label: 'Impact · mass ratio 100', bodies: 2, summary: 'A sphere with 100 times the mass of the brick it hits at 30 m/s, with gravity off.' },
  'impact-1000': { label: 'Impact · mass ratio 1000', bodies: 2, summary: 'A sphere with 1000 times the mass of the brick it hits at 30 m/s, with gravity off.' },
  'drop-box': { label: 'Box drop', bodies: 1, summary: 'One box dropped onto the ground.' },
  'rest-stack': { label: 'Resting stack', bodies: 10, summary: '10 unit boxes stacked in one column.' },
  'pile-100': { label: 'Box pile · 100', bodies: 100, summary: '100 randomly sized and turned boxes dropped into a pile; neighbours can start overlapping.' },
  'pile-1k': { label: 'Box pile · 1k', bodies: 1000, summary: '1,000 randomly sized and turned boxes dropped into a pile; neighbours can start overlapping.' },
  'pile-10k': { label: 'Box pile · 10k', bodies: 10000, summary: '10,000 randomly sized and turned boxes dropped into a pile; neighbours can start overlapping.' },
  'pile-1k-settled': { label: 'Settled box pile · 1k', bodies: 1000, summary: '1,000 randomly sized and turned boxes spaced so none overlap at the start.' },
  'pile-10k-settled': { label: 'Settled box pile · 10k', bodies: 10000, summary: '10,000 randomly sized and turned boxes spaced so none overlap at the start.' },
  'ring-9k': { label: 'Brick ring · 9k', bodies: 9131, summary: 'A stepped ring wall of 9,130 bricks with one ball rolling in toward it.' },
  'ring-110k': { label: 'Brick ring · 110k', bodies: 110441, summary: 'A stepped ring wall of 110,440 bricks with one ball rolling in toward it.' },
};

/**
 * Names for the scene families of compare-side.html, which group cases that differ only in size (see
 * `sceneFamilies`). Single-case families are named by their case label.
 */
export const FAMILY_LABELS: Readonly<Record<string, string>> = {
  'rest-grid-N': 'Resting grid', 'impact-N': 'Impact', 'pile-N': 'Box pile', 'pile-N-settled': 'Settled box pile', 'ring-N': 'Brick ring',
};

const known = (name: string): name is CaseName => Object.hasOwn(CASE_INFO, name);
/** The label for a case ID; an unknown ID is returned as it came, so a typo is visible rather than blank. */
export const caseLabel = (name: string): string => known(name) ? CASE_INFO[name].label : name;
/** The one-sentence description of a case, or '' for an unknown ID. */
export const caseSummary = (name: string): string => known(name) ? CASE_INFO[name].summary : '';
/** The label for a scene family (a `Family.id`) or, for a single-case family, its case. */
export const familyLabel = (id: string): string => FAMILY_LABELS[id] ?? caseLabel(id);
