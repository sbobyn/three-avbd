// The trailer's shots (rig.js must be loaded). Each loads its scene paused, frames it, starts
// recording as it resumes, and moves the camera in one continuous eased move (the friction
// scenes hold still: a moving camera makes their shadow and AO noise shimmer).
const T = window.T;
const S = (T.shots = {});
/** Options for T.runAll: the ring scene (the 28k ring is the 110k one at half the scale). */
const opts = { ring: 'Brick Ring (110k)' };

/** The body lowest in z but the ground (body 0): a rope's free end, a sagging chain's middle. */
const lowest = () => {
  let best = -1, z = Infinity;
  for (let i = 1; i < sim().bodyCount; i++) {
    const p = sim().position(i);
    if (p.length && p[2] < z) [best, z] = [i, p[2]];
  }
  return best;
};
const start = async (scene, view, opts) => {
  state.paused = true;
  await T.load(scene, opts);
  T.view(view);
  await T.sleep(150);
};

S.ring = async () => {
  const k = opts.ring.includes('28k') ? 0.5 : 1;
  const a = { target: [0, -76 * k, 3 * k], dist: 38 * Math.sqrt(k), az: -115, el: 0.1 };
  await start(opts.ring, a);
  return T.record('ring', 6000, async () => {
    state.paused = false;
    await T.tween(a, { target: [0, -5 * k, -5 * k], dist: 250 * k, az: -72, el: 0.58 }, 6500);
  });
};

S.walls = async () => {
  const a = { target: [-6, 0, 2], dist: 70, az: -132, el: 0.3 };
  await start('Brick Walls (27k)', a);
  T.setBall(0.7, 43, 60);
  T.ui = ['.avbd-panel'];
  return T.record('walls', 5000, async () => {
    state.paused = false;
    const drift = T.tween(a, { target: [-4, 4, 2], dist: 60, az: -120, el: 0.27 }, 5000, T.sine);
    await T.sleep(200);
    await T.slide(document.querySelector('.avbd-panel input[aria-label="Radius"]'), 2.2, 500);
    await T.slide(document.querySelector('.avbd-panel input[aria-label="Mass"]'), 1000, 500);
    await T.click([...document.querySelectorAll('.avbd-panel .action')].find((b) => b.textContent.includes('Fire')), 350);
    await T.sleep(450);
    for (const p of [[-24, -6, 4], [-10, 6, 4], [4, -8, 4]]) {
      T.fireAt(p);
      await T.sleep(330);
    }
    await drift;
  });
};

S.breakable = async () => {
  const a = { target: [0, 0, 5], dist: 34, az: -128, el: 0.12 };
  await start('Breakable Wall (600)', a);
  T.setBall(1.4, 2000, 55);
  return T.record('breakable', 3600, async () => {
    state.paused = false;
    const drift = T.tween(a, { target: [0, 2, 4], dist: 30, az: -110, el: 0.1 }, 3600, T.sine);
    await T.sleep(1300);
    T.fireAt([6, 0, 6]);
    await drift;
  });
};

S.rope = async () => {
  const a = { target: [1.5, 0, 1.5], dist: 28, az: 94, el: 0.08 };
  await start('Rope', a);
  let grabbed;
  const stats = await T.record('rope', 5200, async () => {
    state.paused = false;
    const drift = T.tween(a, { target: [0.5, 0, 2], dist: 25, az: 80, el: 0.06 }, 5200, T.sine);
    await T.sleep(1700);
    grabbed = await T.grabBody(lowest() - 3, 420, -120, 650, 450);
    await T.sleep(150);
    T.lift();
    await drift;
  });
  return { ...stats, grabbed };
};

S.chain = async () => {
  const a = { target: [0, 0, 8], dist: 25, az: -125, el: 0.34 };
  await start('Chain Mail (1.6k)', a, { ballDensity: 100 });
  return T.record('chain', 3200, async () => {
    state.paused = false;
    await T.tween(a, { target: [0, 0, 6.5], dist: 21, az: -106, el: 0.28 }, 3200, T.sine);
  });
};

S.springs = async () => {
  const a = { target: [0, 0, 4], dist: 25, az: 90, el: 0.14 };
  await start('Spring Ratio', a);
  T.ui = ['.avbd-label'];
  let grabbed;
  const stats = await T.record('springs', 4200, async () => {
    state.paused = false;
    const drift = T.tween(a, { target: [0, 0, 3.5], dist: 22, az: 78, el: 0.12 }, 4200, T.sine);
    await T.sleep(1500);
    grabbed = await T.grabBody(lowest(), 30, 180, 600, 400);
    await T.sleep(150);
    T.lift();
    await drift;
  });
  return { ...stats, grabbed };
};

S.ragdolls = async () => {
  const a = { target: [0, 0, 6], dist: 52, az: -115, el: 0.3 };
  await start('Ragdolls on Cloth (24k)', a);
  return T.record('ragdolls', 3600, async () => {
    state.paused = false;
    await T.tween(a, { target: [0, 0, 4], dist: 40, az: -95, el: 0.32 }, 3600, T.sine);
  });
};

S.static = async () => {
  // A locked-off camera: moving views make the shadow and AO noise shimmer on the ramp
  await start('Static Friction', { target: [-6.5, 0, 4.8], dist: 23.5, az: 30, el: 0.31 });
  T.ui = ['.avbd-label'];
  return T.record('static', 7000, async () => {
    state.paused = false;
  });
};

S.dynamic = async () => {
  await start('Dynamic Friction', { target: [4, -19, 0], dist: 29, az: -131, el: 0.5 });
  T.ui = ['.avbd-label'];
  return T.record('dynamic', 3800, async () => {
    state.paused = false;
  });
};

S.flag = async () => {
  await T.load('Flag in the Wind (1.5k)');
  params.windSpeed = 12;
  const a = { target: [5.5, 0, 19], dist: 25, az: -74, el: 0.05 };
  T.view(a);
  await T.sleep(2000);
  T.ui = ['.avbd-wind'];
  return T.record('flag', 4800, async () => {
    const drift = T.tween(a, { target: [6, 0, 20], dist: 21, az: -62, el: 0.04 }, 4800, T.sine);
    await T.sleep(250);
    await T.steer([[0.35, 0.05], [0.6, 0.45], [0.15, 0.85], [-0.45, 0.6], [-0.8, -0.05], [-0.4, -0.5]], 3200);
    await drift;
  });
};

S.columns = async () => {
  const a = { target: [0, -73, 5], dist: 20, az: -105, el: 0.12 };
  await T.load('Box Columns (100k)');
  T.view(a);
  T.setBall(1.8, 4000, 70);
  await T.sleep(600);
  return T.record('columns', 7600, async () => {
    await T.grab([0, -75, 5], -380, 60, 750, 450);
    await T.sleep(250);
    T.lift();
    await T.sleep(200);
    T.fireAt([8, -40, 4]);
    await T.sleep(300);
    await T.tween(a, { target: [0, -10, 0], dist: 250, az: -75, el: 0.62 }, 5200);
  });
};

/** The cut's order. */
const ORDER = ['ring', 'walls', 'breakable', 'rope', 'chain', 'springs', 'ragdolls', 'static', 'dynamic', 'flag', 'columns'];

/**
 * Record every shot (or those named), save their numbers to clips/stats.json for build.py, and
 * list any shot that ran below 60 fps (its simulation was then slower than real time).
 */
T.runAll = async (options = {}) => {
  Object.assign(opts, options);
  const names = options.only ?? ORDER;
  const shots = {};
  for (const name of names) {
    shots[name] = await S[name]();
    console.log(name, shots[name]);
  }
  const stats = { gpu: T.gpu, ring: opts.ring, date: new Date().toISOString(), shots };
  await fetch('http://127.0.0.1:8765/clip?name=stats&ext=json&merge=1', { method: 'POST', body: JSON.stringify(stats) });
  const slow = Object.entries(shots).filter(([, s]) => s.fps < 58).map(([n, s]) => `${n} (${s.fps} fps)`);
  return { gpu: T.gpu, shots, slow: slow.length ? slow : 'none: every shot ran at 60 fps or better' };
};
