// The examples gallery (examples/index.html): every page, scene collection and command, as plain
// data. Deliberately imports nothing: the gallery must load without the solver, Three.js, Rapier
// or a GPU device. tests/gallery.test.ts checks this list against the real scene registries
// (src/avbd2d/sim.ts, src/avbd3d/sim.ts via src/ui/scene-menu.ts, src/comparison/scenes.ts,
// src/sdf-released/scenes.ts) and the Vite page inputs, so a new scene without an entry fails.
//
// Links are relative to /examples/index.html. Only query parameters the pages actually read are
// used: `?scene=` on the 3D (/) and 2D (/2d.html) viewers and on compare-side.html. Pages without
// a deep link (sdf.html, sdf-released.html, compare.html) list their contents with a `pick` hint.

export type GroupId = 'contacts' | 'joints' | 'large' | 'sdf' | 'rapier' | 'library' | 'research';
/** How you use it: an interactive scene, a page that prints a result, a measuring tool, a terminal command, or a written guide. */
export type Kind = 'playable' | 'headless' | 'diagnostic' | 'benchmark' | 'command' | 'guide';
export type Engine = 'avbd' | 'rapier';
/** What it needs: WebGPU; WebGPU for the large scenes but CPU for the small ones; Node (no GPU); Node with headless Dawn; nothing (a static page). */
export type Requirement = 'webgpu' | 'webgpu-or-cpu' | 'node' | 'node-gpu' | 'none';

export interface Group { id: GroupId; title: string; blurb: string }

/** A named scene or preset inside an entry: a direct link when the page reads one, else where to pick it. */
export interface Item {
  label: string;
  href?: string;
  /** Searchable names the item also covers, e.g. the body-count variants of one comparison family. */
  covers?: string[];
  /** A very large scene: the link opens it paused and the chip is marked (see HEAVY_NOTE). */
  heavy?: boolean;
}

/** Shown with any entry that has heavy items. Paused does not bound the cost: the scene is still built in full. */
export const HEAVY_NOTE = 'Marked heavy: opens paused, but the whole scene is still built. Memory and time on your device are not qualified.';

export interface Link { label: string; href: string; note?: string }

export interface Entry {
  id: string;
  title: string;
  /** One concrete sentence: what to try and what it shows. */
  description: string;
  group: GroupId;
  kind: Kind;
  engines: Engine[];
  requires: Requirement;
  /** Under active development; behaviour and API may change. */
  experimental?: boolean;
  /** 2D or 3D, where it matters. */
  dimension?: '2D' | '3D';
  /** Primary action. Absent for commands, which show `command` instead. */
  href?: string;
  command?: string;
  /** Repository source path (shown as a "source" link). */
  source?: string;
  /** Static illustration in /public/gallery (never a screenshot unless `thumbKind` says so). */
  thumb: string;
  thumbKind: 'illustration';
  thumbAlt: string;
  items?: Item[];
  /** Hint shown above `items` when they cannot be linked directly. */
  pick?: string;
  links?: Link[];
  /** Honest limits worth reading before drawing conclusions. */
  limits?: string;
  /** Paired study: the same physical intent built in each engine. */
  pair?: { rapier: string; avbd: string };
}

export const GROUPS: Group[] = [
  { id: 'contacts', title: 'Contacts and stacks', blurb: 'Pyramids, stacks with heavy blocks on light ones, and friction on a slope.' },
  { id: 'joints', title: 'Joints, springs and breaking', blurb: 'Ropes, bridges, springs and joints that snap or bend and stay bent.' },
  { id: 'large', title: 'Large GPU scenes', blurb: "The paper's big scenes, scale tests and scenes you size yourself. Most need WebGPU." },
  { id: 'sdf', title: 'Nonconvex SDF collisions', blurb: 'Rings, gears and hollow shapes that keep their holes. Experimental.' },
  { id: 'rapier', title: 'Rapier comparisons', blurb: 'The same intent in Rapier and three-avbd. Check quality first; timings come second.' },
  { id: 'library', title: 'Build with the library', blurb: 'Small programs that use only the public package entries; copy them into your project.' },
  { id: 'research', title: 'Results and benchmarks', blurb: "Timing tools and recorded results against the paper's figures." },
];

export const KIND_LABELS: Record<Kind, string> = {
  playable: 'Playable', headless: 'Headless', diagnostic: 'Diagnostic', benchmark: 'Benchmark', command: 'Command', guide: 'Guide',
};
export const ENGINE_LABELS: Record<Engine, string> = { avbd: 'three-avbd', rapier: 'Rapier' };
export const REQUIREMENT_LABELS: Record<Requirement, string> = {
  webgpu: 'WebGPU', 'webgpu-or-cpu': 'Small scenes: CPU physics available', node: 'Node, no GPU', 'node-gpu': 'Node + headless WebGPU', none: 'No GPU needed',
};

const scene3D = (name: string): Item => ({ label: name, href: `../index.html?scene=${encodeURIComponent(name)}` });
const scene2D = (name: string): Item => ({ label: name, href: `../2d.html?scene=${encodeURIComponent(name)}` });
/** A comparison case: the searchable case ID selects exactly the linked input. */
const side = (label: string, scene: string): Item => {
  const heavy = isHeavyCase(scene);
  return { label, href: `../compare-side.html?scene=${scene}${heavy ? '&paused=1' : ''}`, covers: [scene], ...(heavy ? { heavy } : {}) };
};
/** Comparison cases of 9k bodies and up (rest-grid-10k, pile-10k, ring-9k, ring-110k...), named by their `Nk` count. */
export function isHeavyCase(id: string): boolean {
  const thousands = /-(\d+)k(?:-|$)/.exec(id);
  return thousands !== null && Number(thousands[1]) >= 9;
}
const GITHUB = 'https://github.com/sbobyn/three-avbd/blob/main/';
const TWO_D_LIMITS = "The 2D solver is a TypeScript port of the authors' 2D demo for study, with a GPU backend. It is not part of the published three-avbd package, which is 3D.";
export const sourceUrl = (path: string) => GITHUB + path;

export const ENTRIES: Entry[] = [
  // Start here (see FEATURED) is drawn from these entries; every entry belongs to one group.
  {
    id: 'playground-3d', title: '3D physics playground', group: 'contacts', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '3D',
    description: 'Drag blocks, press Space to fire a cannonball and switch scenes from the menu. A one-time GPU speed check picks the opening scene: a 28,000-brick ring, a 2,000-body wall or a Pyramid.',
    href: '../index.html', source: 'src/app3d/main.ts', thumb: 'playground-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'Coloured blocks stacked in a pyramid with a cannonball flying towards it',
  },
  {
    id: 'contacts-3d', title: 'Stacks and friction in 3D', group: 'contacts', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '3D',
    description: 'Put a heavy block on a light one in Stack Ratio, or watch boxes hold and slide on Static and Dynamic Friction slopes.',
    href: '../index.html?scene=Pyramid', source: 'src/avbd3d/ref/scenes.ts', thumb: 'contacts-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'A tall stack with a large block resting on a small one, beside boxes on a slope',
    items: ['Pyramid', 'Stack', 'Stack Ratio', 'Dynamic Friction', 'Static Friction'].map(scene3D),
  },
  {
    id: 'contacts-2d', title: 'Stacks and friction in 2D', group: 'contacts', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '2D',
    description: "The authors' 2D demo ported to TypeScript: build a house of Cards, then switch the backend between CPU and GPU to compare.",
    href: '../2d.html?scene=Pyramid', source: 'src/avbd2d/ref/scenes.ts', thumb: 'contacts-2d.svg', thumbKind: 'illustration',
    thumbAlt: 'A flat 2D pyramid of boxes next to a leaning house of cards',
    items: ['Pyramid', 'Cards', 'Stack', 'Stack Ratio', 'Dynamic Friction', 'Static Friction'].map(scene2D),
    limits: TWO_D_LIMITS,
  },
  {
    id: 'joints-3d', title: 'Ropes, bridges and breakable joints', group: 'joints', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '3D',
    description: 'Hang a heavy block on a rope, load a bridge, snap a Breakable chain or bend the Plastic Beam until it stays bent.',
    href: '../index.html?scene=Bridge', source: 'src/avbd3d/ref/scenes.ts', thumb: 'joints-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'A plank bridge sagging between two posts, with a broken chain hanging beside it',
    items: ['Rope', 'Heavy Rope', 'Bridge', 'Breakable', 'Plastic Beam', 'Spring', 'Spring Ratio', 'Soft Body'].map(scene3D),
    limits: 'Soft Body is a grid of rigid boxes held by soft joints, not a continuum or finite-element soft body. The scene names follow the AVBD demos.',
  },
  {
    id: 'joints-2d', title: 'Ropes, nets and motors in 2D', group: 'joints', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '2D',
    description: 'Shake a Net, drive the Motor, or break a jointed block apart in Fracture. Drag any body to pull it.',
    href: '../2d.html?scene=Rope', source: 'src/avbd2d/ref/scenes.ts', thumb: 'joints-2d.svg', thumbKind: 'illustration',
    thumbAlt: 'A 2D net of jointed nodes sagging under a weight, next to a spinning motor',
    items: ['Rope', 'Heavy Rope', 'Hanging Rope', 'Rod', 'Spring', 'Spring Ratio', 'Soft Body', 'Joint Grid', 'Net', 'Motor', 'Fracture'].map(scene2D),
    limits: `Soft Body is a grid of rigid boxes held by soft joints, not a continuum soft body. ${TWO_D_LIMITS}`,
  },
  {
    id: 'paper-3d', title: "The paper's large scenes", group: 'large', kind: 'playable', engines: ['avbd'], requires: 'webgpu', dimension: '3D',
    description: 'Topple a 28,000-brick ring, smash a wall with the cannonball, or drop ragdolls on a sheet of linked plates. Scenes after the AVBD paper figures, on your GPU.',
    href: '../index.html?scene=Brick%20Ring%20(28k)', source: 'src/avbd3d/bench-scenes.ts', thumb: 'paper-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'A circular ring of bricks, partly toppled, seen from above at an angle',
    items: ['Brick Ring (28k)', 'Brick Ring (110k)', 'Brick Walls (27k)', 'Wall Smash (2k)', 'Breakable Wall (600)', 'Chain Mail (1.6k)', 'Ragdolls on Cloth (24k)', 'Flag in the Wind (1.5k)', 'Heavy Pendulum'].map(scene3D),
    limits: 'Scene layouts follow the paper; its reported timings are not a claim about your device. See Results vs the paper. The "cloth" in Ragdolls on Cloth and Flag in the Wind is a grid of thin rigid plates on ball joints, not a cloth simulation.',
  },
  {
    id: 'paintings-3d', title: 'Paintings made of blocks', group: 'large', kind: 'playable', engines: ['avbd'], requires: 'webgpu', dimension: '3D',
    description: 'Knock down Starry Night built from 20,000 coloured blocks, or the 50,000-block Mona Lisa Tower.',
    href: '../index.html?scene=Starry%20Night%20(20k)', source: 'src/avbd3d/painting.ts', thumb: 'paintings-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'A wall of small coloured tiles forming swirling sky, with a tall tiled tower beside it',
    items: ['Starry Night (20k)', 'Mona Lisa Tower (50k)'].map(scene3D),
  },
  {
    id: 'scale-3d', title: 'Scale tests in 3D', group: 'large', kind: 'playable', engines: ['avbd'], requires: 'webgpu', dimension: '3D',
    description: 'Push the body count: pile 32,000 boxes or stand 100,000 in columns, and read the step time in the timing panel.',
    href: '../index.html?scene=Box%20Pile%20(4k)', source: 'src/avbd3d/bench-scenes.ts', thumb: 'scale-3d.svg', thumbKind: 'illustration',
    thumbAlt: 'A dense heap of many small boxes beside tall thin columns',
    items: ['Jointed Drop (34k)', 'Box Pile (4k)', 'Box Pile (32k)', 'Box Columns (100k)'].map(scene3D),
  },
  {
    id: 'scale-2d', title: 'Scale tests in 2D', group: 'large', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu', dimension: '2D',
    description: 'Rain thousands of boxes or swing a wrecking ball into a 40,000-box wall. The smaller sizes run on the CPU; the largest need the GPU backend.',
    href: '../2d.html?scene=Pyramid%2050%20(1.3k)', source: 'src/avbd2d/bench-scenes.ts', thumb: 'scale-2d.svg', thumbKind: 'illustration',
    thumbAlt: 'A wrecking ball on a chain swinging into a wide wall of small boxes',
    items: [
      'Pyramid 50 (1.3k)', 'Pyramid 100 (5k)', 'Box Rain 40x25 (1k)', 'Box Rain 100x50 (5k)', 'Joint Lattice 64x64 (4k)', 'Wrecking Ball 100x40 (4k)',
      'Pyramid 200 (20k)', 'Wrecking Ball 400x100 (40k)', 'Box Rain 900x100 (90k)', 'Joint Lattice 320x320 (100k)', 'Joint Lattice 512x512 (262k)',
    ].map(scene2D),
    limits: TWO_D_LIMITS,
  },
  {
    id: 'custom', title: 'Build your own scene', group: 'large', kind: 'playable', engines: ['avbd'], requires: 'webgpu-or-cpu',
    description: 'Pick a scene type and body count from the Custom panel and find where your device stops keeping up.',
    href: '../index.html?scene=Custom', source: 'src/avbd3d/custom.ts', thumb: 'custom.svg', thumbKind: 'illustration',
    thumbAlt: 'A slider controlling how many blocks fill a scene',
    items: [{ label: '3D Custom (WebGPU)', href: '../index.html?scene=Custom' }, { label: '2D Custom', href: '../2d.html?scene=Custom' }],
    limits: `The 2D Custom scene runs on the 2D solver. ${TWO_D_LIMITS}`,
  },
  {
    id: 'sdf-playground', title: 'SDF playground', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'Drop rings, twisted solids and baked gears into a pile and grab them. Rings hook through each other because their holes stay open.',
    href: '../sdf.html', source: 'src/sdf-showcase/main.ts', thumb: 'sdf-playground.svg', thumbKind: 'illustration',
    thumbAlt: 'Two tori linked through each other above a twisted block and a gear',
    pick: 'Choose with the Scene menu on the page:',
    items: [{ label: '01 · Rings' }, { label: '02 · Twisted solids' }, { label: '03 · Baked gears' }],
  },
  {
    id: 'sdf-gear-train', title: 'Gear train', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'Turn one wheel and watch tooth contacts alone drive the rest of the train; no joints couple the gears.',
    href: '../sdf-gears.html', source: 'src/sdf-gears/main.ts', thumb: 'sdf-gear-train.svg', thumbKind: 'illustration',
    thumbAlt: 'Three meshing gears of different sizes with arrows showing opposite rotation',
  },
  {
    id: 'sdf-released', title: 'SDF collision studies', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: "Eleven scenes after the SDF collision paper's released demo: chairs, bunnies, spiky wheels. Compare mesh-quality and released contact settings.",
    href: '../sdf-released.html', source: 'src/sdf-released/scenes.ts', thumb: 'sdf-released.svg', thumbKind: 'illustration',
    thumbAlt: 'A wheel with spikes resting on a pile of small chair shapes',
    pick: 'Choose with the Scene menu on the page:',
    items: ['Box Stack', 'Gear Stack', 'Falling Boxes', 'Falling Boxes: Bend', 'Falling Boxes: Twist', 'Falling Boxes: Displace', 'Pile of Chairs', 'Spiky Wheel', 'Cows on Spikes', 'Bunny Pile', 'Primitives'].map(label => ({ label })),
    limits: 'Reproductions, not paper parity: the original uses a CPU optimizer and a different solver. See docs/SDF_RELEASED_COMPARISON.md.',
  },
  {
    id: 'sdf-gear', title: 'Two meshing gears', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'The smallest SDF example: bake a gear mesh, drive one gear kinematically and let its teeth push the other.',
    href: './sdf-gear.html', source: 'examples/sdf-gear.ts', thumb: 'sdf-gear.svg', thumbKind: 'illustration',
    thumbAlt: 'Two gears with clearly drawn teeth meshing at one point',
  },
  {
    id: 'sdf-hollow', title: 'Balls in a torus', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'Drop balls into an analytic torus field: they rest inside the tube and fall through the hole, which a convex hull would fill.',
    href: './sdf-hollow.html', source: 'examples/sdf-hollow.ts', thumb: 'sdf-hollow.svg', thumbKind: 'illustration',
    thumbAlt: 'A cut-away torus with balls lying inside its tube and one dropping through the centre hole',
  },
  {
    id: 'sdf-from-mesh', title: 'SDF from a mesh', group: 'sdf', kind: 'playable', engines: ['avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'Bake a field from a triangle mesh in a worker, read its mass properties and principal frame, and see where the API stops.',
    href: './sdf-from-mesh.html', source: 'examples/sdf-from-mesh.ts', thumb: 'sdf-from-mesh.svg', thumbKind: 'illustration',
    thumbAlt: 'A triangle mesh outline over a grid of distance samples with principal axes drawn through it',
  },
  {
    id: 'interlocking-pair', title: 'Interlocking sculpture: Rapier and AVBD', group: 'rapier', kind: 'playable', engines: ['rapier', 'avbd'], requires: 'webgpu', experimental: true, dimension: '3D',
    description: 'Two linked rings hang on a peg with contact only, no joints. Push the lower ring in Rapier first, then do the same in the AVBD counterpart.',
    href: './interlocking-rapier.html', source: 'docs/PAIRED_STUDIES.md', thumb: 'interlocking-pair.svg', thumbKind: 'illustration',
    thumbAlt: 'Two linked rings hanging from a peg, drawn twice side by side',
    pair: { rapier: './interlocking-rapier.html', avbd: './interlocking-avbd.html' },
    links: [{ label: 'Bounded trial CLI', href: sourceUrl('scripts/interlocking-trial.ts') }],
    limits: 'Same rings, peg, mass, push and camera, but different geometry: Rapier uses 16–64 convex pieces per ring, AVBD exact analytic torus fields. AVBD reads poses back asynchronously, has no native sleeping or CCD, does not model restitution, and its default SDF regularization can add drag. Observations, not a winner or a benchmark.',
  },
  {
    id: 'side-by-side', title: 'Rapier and AVBD side by side', group: 'rapier', kind: 'diagnostic', engines: ['rapier', 'avbd'], requires: 'webgpu', dimension: '3D',
    description: 'Run one scene in both engines at once with linked cameras; each scene says whether it is valid for a resting comparison.',
    href: '../compare-side.html', source: 'src/comparison/side.ts', thumb: 'side-by-side.svg', thumbKind: 'illustration',
    thumbAlt: 'A split view with the same pile of boxes on the left and right',
    items: [
      side('Impact train', 'impact-train'), side('Free fall', 'free-fall'), side('Slide', 'slide'), side('Spin', 'spin'),
      side('Resting grid · 100', 'rest-grid-100'), side('Resting grid · 1k', 'rest-grid-1k'), side('Resting grid · 10k', 'rest-grid-10k'),
      side('Stack of 50', 'stack-50'), side('Heavy stack', 'stack-heavy'), side('Chain of 20', 'chain-20'), side('Heavy chain', 'chain-heavy'),
      side('Sphere pile', 'sphere-pile-100'), side('Sphere pile, packed', 'sphere-pile-hcp-100'),
      side('Grazing impact', 'impact-graze'), side('Rotating impact', 'impact-rotate'),
      side('Impact · mass ratio 1', 'impact-1'), side('Impact · mass ratio 100', 'impact-100'), side('Impact · mass ratio 1000', 'impact-1000'),
      side('Box drop', 'drop-box'), side('Resting stack', 'rest-stack'),
      side('Box pile · 100', 'pile-100'), side('Box pile · 1k', 'pile-1k'), side('Box pile · 10k', 'pile-10k'),
      side('Settled box pile · 1k', 'pile-1k-settled'), side('Settled box pile · 10k', 'pile-10k-settled'),
      side('Brick ring · 9k', 'ring-9k'), side('Brick ring · 110k', 'ring-110k'),
    ],
    links: [{ label: 'Rendered workflow benchmark', href: '../compare-frame.html', note: 'diagnostic: same renderer for both engines, alternating repeats' }],
    limits: 'Equal iteration counts are not equal work or accuracy. Rapier sleeping is a setting here; AVBD has none.',
  },
  {
    id: 'quality-runner', title: 'Physics quality comparison', group: 'rapier', kind: 'diagnostic', engines: ['rapier', 'avbd'], requires: 'webgpu',
    description: 'Measure one case in both engines without drawing: floor and contact penetration checks, an exact replay and batched timing, with a raw JSON report.',
    href: '../compare.html', source: 'src/comparison/run.ts', thumb: 'quality-runner.svg', thumbKind: 'illustration',
    thumbAlt: 'Two overlaid error curves on a chart with a pass threshold line',
    pick: 'Choose any of the side-by-side cases from the Scene menu on the page.',
    limits: 'Preliminary, physics only. Passing the penetration targets does not establish overall accuracy; compare timings only where both engines meet them. See docs/COMPARISON.md.',
  },
  {
    id: 'compare-cli', title: 'Comparison from the terminal', group: 'rapier', kind: 'command', engines: ['rapier', 'avbd'], requires: 'node-gpu',
    description: 'Run the same comparison cases headless in Node with Dawn and print or save the report.',
    command: 'pnpm compare:rapier', source: 'scripts/compare-rapier.ts', thumb: 'command.svg', thumbKind: 'illustration',
    thumbAlt: 'A terminal window printing a small table',
  },
  {
    id: 'basic-world', title: 'Basic world', group: 'library', kind: 'playable', engines: ['avbd'], requires: 'webgpu', dimension: '3D',
    description: 'A box pyramid, raining spheres, convex-hull rocks and a breakable joint chain in one short file: the place to start your own scene.',
    href: './basic.html', source: 'examples/basic.ts', thumb: 'basic-world.svg', thumbKind: 'illustration',
    thumbAlt: 'A small box pyramid with spheres falling and rocks on the ground',
  },
  {
    id: 'body-lifecycle', title: 'Body lifecycle', group: 'library', kind: 'headless', engines: ['avbd'], requires: 'webgpu',
    description: 'Enable, disable, reset and remove bodies, and watch a freed slot get reused. Prints the result; nothing is drawn.',
    href: './body-lifecycle.html', source: 'examples/body-lifecycle.ts', thumb: 'body-lifecycle.svg', thumbKind: 'illustration',
    thumbAlt: 'A row of body slots, one crossed out and then refilled',
  },
  {
    id: 'body-pool', title: 'Body pool', group: 'library', kind: 'headless', engines: ['avbd'], requires: 'webgpu',
    description: 'A fixed-storage World recycling spheres through a BodyPool with no new GPU allocations. Prints the result.',
    href: './body-pool.html', source: 'examples/body-pool.ts', thumb: 'body-pool.svg', thumbKind: 'illustration',
    thumbAlt: 'Spheres leaving and re-entering a fixed rack of slots',
  },
  {
    id: 'pose-playback', title: 'Pose playback', group: 'library', kind: 'playable', engines: ['avbd'], requires: 'webgpu', dimension: '3D',
    description: 'Play back a pose track you captured with the headless World in Node: choose the JSON file it wrote; plain Three.js draws it, with no physics in the page.',
    href: './pose-playback.html', source: 'examples/pose-playback.ts', thumb: 'pose-playback.svg', thumbKind: 'illustration',
    thumbAlt: 'A saved track file feeding ghosted copies of a sphere along a bounce path',
    links: [{ label: 'Capture CLI (Node + Dawn)', href: sourceUrl('examples/pose-capture.ts') }, { label: 'User guide steps', href: sourceUrl('docs/USER_GUIDE.md#capture-poses-and-play-them-back') }],
    limits: 'Needs a track file you capture yourself on a hardware GPU; none ships with the site. Transforms only: no velocities, events or World state, so it cannot restore a World or claim a repeatable replay. Example-local, provisional format.',
  },
  {
    id: 'static-projectile', title: 'Static projectile queries', group: 'library', kind: 'command', engines: ['avbd'], requires: 'node',
    description: 'Sweep spheres against static meshes on the CPU with three-avbd/queries; no browser or GPU needed.',
    command: 'node --experimental-transform-types examples/static-projectile.ts', source: 'examples/static-projectile.ts', thumb: 'static-projectile.svg', thumbKind: 'illustration',
    thumbAlt: 'A sphere swept along a dashed path, stopping where it meets a wall',
  },
  {
    id: 'fresh-project', title: 'Fresh project setup', group: 'library', kind: 'guide', engines: ['avbd'], requires: 'webgpu',
    description: 'Follow the setup guide to install a locally built package in a new Vite project, then copy two files to check it works outside this repository.',
    href: sourceUrl('docs/SETUP.md#fresh-threejs-consumer'), source: 'examples/fresh-project/main.js', thumb: 'fresh-project.svg', thumbKind: 'illustration',
    thumbAlt: 'An opened package box with a small cube inside',
  },
  {
    id: 'results', title: 'Results vs the paper', group: 'research', kind: 'benchmark', engines: ['avbd'], requires: 'none',
    description: "Recorded step times from saved machine reports beside the paper's reported times; paste your own report to add it.",
    href: '../results.html', source: 'src/results/main.ts', thumb: 'results.svg', thumbKind: 'illustration',
    thumbAlt: 'Paired bars comparing recorded times to reference times',
    limits: 'Saved reports name their machine; they do not certify other hardware.',
  },
  {
    id: 'bench-3d', title: 'Benchmark your GPU (3D)', group: 'research', kind: 'benchmark', engines: ['avbd'], requires: 'webgpu',
    description: "Time the paper's 3D scenes on this machine and download the results for the Results page.",
    href: '../bench3d.html', source: 'src/bench3d/main.ts', thumb: 'bench.svg', thumbKind: 'illustration',
    thumbAlt: 'A stopwatch next to a bar chart',
    links: [{ label: 'Headless: pnpm bench3d:gpu', href: sourceUrl('scripts/bench3d-gpu.ts') }],
  },
  {
    id: 'bench-2d', title: 'Benchmark your GPU (2D)', group: 'research', kind: 'benchmark', engines: ['avbd'], requires: 'webgpu', dimension: '2D',
    description: 'Time a fixed 2D scene suite on this GPU per solver phase and copy the numbers back.',
    href: '../bench.html', source: 'src/bench2d/main.ts', thumb: 'bench-2d.svg', thumbKind: 'illustration',
    thumbAlt: 'Stacked timing bars split into solver phases',
  },
];

/** The first row: a useful first pick of each sort. Ids of ENTRIES. */
export const FEATURED: { id: string; why: string }[] = [
  { id: 'playground-3d', why: 'See it move' },
  { id: 'interlocking-pair', why: 'Compare with Rapier' },
  { id: 'sdf-playground', why: 'Nonconvex shapes' },
  { id: 'basic-world', why: 'Write your own' },
];
