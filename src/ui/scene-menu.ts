// The scene menu shared by the 3D (index.html) and 2D (2d.html) demos: each demo's scenes
// grouped by kind, plus the other demo's (choosing one opens that demo). Shown by controls.ts.

import { allScenes2D } from '../avbd2d/sim.ts';
import { allScenes3D } from '../avbd3d/sim.ts';

export type Dimension = '2d' | '3d';

interface MenuItem {
  label: string;
  value: string;
  /** A short remark shown beside it (e.g. that the scene will be slow on this device). */
  note?: string;
}

export interface MenuGroup {
  label: string;
  items: MenuItem[];
}

export interface SceneMenu {
  own: MenuGroup[];
  /** The other demo's scenes, under one heading. */
  other: { title: string; groups: MenuGroup[] };
}

/** Kinds of scene, by name; a scene not listed here goes under "More". */
const KINDS: Record<Dimension, Record<string, string[]>> = {
  '3d': {
    'Paper scenes (GPU)': [
      'Brick Ring (28k)',
      'Brick Ring (110k)',
      'Brick Walls (27k)',
      'Wall Smash (2k)',
      'Breakable Wall (600)',
      'Chain Mail (1.6k)',
      'Ragdolls on Cloth (24k)',
      'Flag in the Wind (1.5k)',
      'Heavy Pendulum',
    ],
    'Scale tests (GPU)': ['Jointed Drop (34k)', 'Box Pile (4k)', 'Box Pile (32k)', 'Box Columns (100k)'],
    'Contacts & friction': ['Pyramid', 'Stack', 'Stack Ratio', 'Dynamic Friction', 'Static Friction'],
    'Joints & springs': ['Rope', 'Heavy Rope', 'Bridge', 'Breakable', 'Spring', 'Spring Ratio', 'Soft Body'],
    'Build your own': ['Custom'],
  },
  '2d': {
    'Contacts & friction': ['Pyramid', 'Cards', 'Stack', 'Stack Ratio', 'Dynamic Friction', 'Static Friction'],
    'Joints & springs': ['Rope', 'Heavy Rope', 'Hanging Rope', 'Rod', 'Spring', 'Spring Ratio', 'Soft Body', 'Joint Grid', 'Net', 'Motor', 'Fracture'],
    'Scale tests': [
      'Pyramid 50 (1.3k)',
      'Pyramid 100 (5k)',
      'Box Rain 40x25 (1k)',
      'Box Rain 100x50 (5k)',
      'Joint Lattice 64x64 (4k)',
      'Wrecking Ball 100x40 (4k)',
    ],
    'Scale tests (GPU)': [
      'Pyramid 200 (20k)',
      'Wrecking Ball 400x100 (40k)',
      'Box Rain 900x100 (90k)',
      'Joint Lattice 320x320 (100k)',
      'Joint Lattice 512x512 (262k)',
    ],
    'Build your own': ['Custom'],
  },
};

/** Scenes kept for the tests and URLs but not listed (the demos' empty sandboxes). */
const UNLISTED = new Set(['Ground', 'Empty']);

const PAGES: Record<Dimension, string> = { '3d': '/', '2d': '/2d.html' };
const TITLES: Record<Dimension, string> = { '3d': '3D', '2d': '2D' };

/** One demo's scenes among `names`, grouped and ordered by kind. */
function groupsOf(dim: Dimension, names: string[], toValue: (name: string) => string, noteOf: (name: string) => string | undefined = () => undefined): MenuGroup[] {
  const kinds = KINDS[dim];
  const listed = new Set(Object.values(kinds).flat());
  const item = (n: string): MenuItem => ({ label: n, value: toValue(n), note: noteOf(n) });
  const groups = Object.entries(kinds).map(([kind, members]) => ({
    label: kind,
    items: members.filter((n) => names.includes(n)).map(item),
  }));
  const other = names.filter((n) => !listed.has(n) && !UNLISTED.has(n));
  if (other.length) groups.push({ label: 'More', items: other.map(item) });
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The menu for the demo `dim`: its own scenes (values are scene names; `available` lists the
 * ones this browser can run; `noteOf` remarks on them), and the other demo's (values
 * "2d:Name" / "3d:Name").
 */
export function sceneMenu(dim: Dimension, available: string[], noteOf?: (name: string) => string | undefined): SceneMenu {
  const other: Dimension = dim === '3d' ? '2d' : '3d';
  const otherNames = (other === '3d' ? allScenes3D : allScenes2D).map((s) => s.name);
  return {
    own: groupsOf(dim, available, (n) => n, noteOf),
    other: { title: `${TITLES[other]} demo`, groups: groupsOf(other, otherNames, (n) => `${other}:${n}`) },
  };
}

/** For a value from the other demo's groups, the URL that opens it; null for this demo's scenes. */
export function otherDemoUrl(value: string): string | null {
  const m = /^(2d|3d):(.+)$/.exec(value);
  return m ? `${PAGES[m[1] as Dimension]}?scene=${encodeURIComponent(m[2])}` : null;
}
