// Trailer recording rig, imported into the running 3D demo (see README.md). Composites the
// WebGPU canvas, the page's UI (rasterised from the DOM each few frames) and a cursor onto one
// canvas, which it records; scripts camera moves, grabs and UI interaction.
const W = 1920, H = 1080;
if (innerWidth !== W || innerHeight !== H) {
  throw new Error(`The page is ${innerWidth}×${innerHeight}: set it to 1920×1080 (DevTools → device toolbar → Responsive → 1920 × 1080, DPR 1), reload, and import again`);
}
const T = (window.T = {});
const canvas = document.querySelector('#view');
const adapter = await navigator.gpu?.requestAdapter();
T.gpu = adapter?.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description].filter(Boolean).join(' · ') : 'unknown';
canvas.setPointerCapture = () => {};
renderer.renderer.setPixelRatio(1);
window.dispatchEvent(new Event('resize'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const D = Math.PI / 180;
T.sleep = sleep;

// --- Easing ------------------------------------------------------------------------------
/** Quintic smootherstep: zero velocity and acceleration at both ends. */
T.smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Sine in-out: gentle, for long drifts. */
T.sine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
/** Starts moving, eases to a stop (for moves already under way at the cut). */
T.out = (t) => 1 - Math.pow(1 - t, 3);

// --- Camera ------------------------------------------------------------------------------
T.view = (v) => {
  const [tx, ty, tz] = v.target;
  controls.target.set(tx, ty, tz);
  camera.position.set(tx + v.dist * Math.cos(v.el) * Math.cos(v.az * D), ty + v.dist * Math.cos(v.el) * Math.sin(v.az * D), tz + v.dist * Math.sin(v.el));
  camera.lookAt(controls.target);
};
T.current = () => {
  const t = controls.target, p = camera.position, d = p.clone().sub(t), dist = d.length();
  return { target: [t.x, t.y, t.z], dist, az: Math.atan2(d.y, d.x) / D, el: Math.asin(d.z / dist) };
};
const lerp = (a, b, t) => a + (b - a) * t;
T.tween = async (a, b, ms, e = T.smooth) => {
  const t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), k = e(u);
    T.view({ target: a.target.map((x, i) => lerp(x, b.target[i], k)), dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), k)), az: lerp(a.az, b.az, k), el: lerp(a.el, b.el, k) });
    if (u >= 1) return;
    await raf();
  }
};

// --- Scenes and balls --------------------------------------------------------------------
T.load = async (scene, opts) => {
  if (opts) state.sceneOptions[scene] = { ...state.sceneOptions[scene], ...opts };
  setScene(scene);
  await sleep(300);
  while (!document.querySelector('#building').hidden) await sleep(50);
  await sleep(200);
};
T.setBall = (r, m, v) => Object.assign(state, { ballRadius: r, ballMass: m, ballSpeed: v });
T.fireAt = (p) => window.shootBall(new camera.position.constructor(...p).sub(camera.position).normalize());
T.screen = (p) => {
  const v = new camera.position.constructor(p[0], p[1], p[2]).project(camera);
  return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
};

// --- Cursor and pointer ------------------------------------------------------------------
const cursor = (T.cursor = { x: W * 0.62, y: H * 0.6, shown: false, down: false, pulse: 0, fadeAt: null });
const pointer = (target, type, x, y, down) =>
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, bubbles: true }));
/**
 * The pointer is over the canvas, as a real mouse's would be: the app then reads body poses
 * back (picking tests them; without, it picks against stale poses and misses) and the body
 * under it glows.
 */
let entered = false;
const enter = () => {
  if (entered) return;
  entered = true;
  canvas.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 1, pointerType: 'mouse', clientX: cursor.x, clientY: cursor.y }));
};
/** Glide the cursor to (x, y), hovering (or dragging, while pressed). */
T.glide = async (x, y, ms = 450) => {
  cursor.shown = true;
  enter();
  if (!cursor.down) cursor.fadeAt = null;
  const [x0, y0] = [cursor.x, cursor.y], t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), k = T.smooth(u);
    cursor.x = lerp(x0, x, k);
    cursor.y = lerp(y0, y, k);
    pointer(cursor.target ?? canvas, 'pointermove', cursor.x, cursor.y, cursor.down);
    if (u >= 1) return;
    await raf();
  }
};
T.press = (target = canvas) => {
  cursor.down = true;
  cursor.target = target;
  cursor.pulse = performance.now();
  pointer(target, 'pointerdown', cursor.x, cursor.y, true);
};
T.lift = () => {
  if (!cursor.down) return;
  pointer(cursor.target ?? canvas, 'pointerup', cursor.x, cursor.y, false);
  cursor.down = false;
  cursor.target = null;
  // Let go: the cursor fades away shortly after
  cursor.fadeAt = performance.now() + 350;
};
/**
 * Grab whatever is under world point p and drag it by (dx, dy) pixels. A miss lets go at once
 * (dragging empty canvas would orbit the camera) and returns -1.
 */
T.grab = async (p, dx, dy, ms = 800, glideMs = 350) => {
  const [x, y] = T.screen(p);
  await T.glide(x, y, glideMs);
  T.press(canvas);
  const body = sim().dragBody;
  if (body < 0) {
    T.lift();
    return -1;
  }
  await T.glide(x + dx, y + dy, ms);
  return body;
};
/** Glide onto a moving body (tracking it), grab it, and drag it by (dx, dy) pixels. */
T.grabBody = async (body, dx, dy, ms = 700, glideMs = 450) => {
  cursor.shown = true;
  cursor.fadeAt = null;
  const [x0, y0] = [cursor.x, cursor.y], t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / glideMs, 1), k = T.smooth(u);
    const [x, y] = T.screen(sim().position(body));
    cursor.x = lerp(x0, x, k);
    cursor.y = lerp(y0, y, k);
    if (u >= 1) break;
    await raf();
  }
  T.press(canvas);
  const grabbed = sim().dragBody;
  if (grabbed < 0) {
    T.lift();
    return -1;
  }
  await T.glide(cursor.x + dx, cursor.y + dy, ms);
  return grabbed;
};
/**
 * Grab and let go of `body` off camera (before a take): the first grab after a page load
 * compiles the drag line's shader, a visible stall mid-take.
 */
T.warmGrab = async (body) => {
  const [x, y] = T.screen(sim().position(body));
  pointer(canvas, 'pointerdown', x, y, true);
  for (let i = 0; i < 4; i++) await raf();
  pointer(canvas, 'pointerup', x, y, false);
  await raf();
};
/** No body under screen point (x, y): pressing there orbits or pans the camera, not grabs. */
T.empty = (x, y) => {
  const V = camera.position.constructor;
  const dir = new V((x / W) * 2 - 1, 1 - (y / H) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
  return !sim().pick(camera.position.toArray(), dir.toArray());
};
/**
 * Drag the camera as a person would: press at points[0] (button 0 orbits, 2 pans), sweep on an
 * eased curve through the rest, and let go (the controls' damping carries it on a little).
 */
T.drag = async (points, ms, button = 0, e = T.smooth) => {
  const buttons = button === 2 ? 2 : 1;
  const send = (type, down) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', clientX: cursor.x, clientY: cursor.y, button, buttons: down ? buttons : 0, bubbles: true }));
  await T.glide(...points[0], 1);
  cursor.down = true;
  send('pointerdown', true);
  const P = points, n = P.length - 1;
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  const t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), s = e(u) * n, i = Math.min(Math.floor(s), n - 1), f = s - i;
    const p = (k) => P[Math.max(0, Math.min(n, k))];
    cursor.x = cr(p(i - 1)[0], p(i)[0], p(i + 1)[0], p(i + 2)[0], f);
    cursor.y = cr(p(i - 1)[1], p(i)[1], p(i + 1)[1], p(i + 2)[1], f);
    send('pointermove', true);
    if (u >= 1) break;
    await raf();
  }
  send('pointerup', false);
  cursor.down = false;
};
/** Scroll the wheel by `total` (negative zooms in) over `ms`, eased, as a trackpad's stream of small steps. */
T.scroll = async (total, ms, e = T.smooth) => {
  const t0 = performance.now();
  let done = 0;
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), to = total * e(u);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: to - done, deltaMode: 0, clientX: cursor.x, clientY: cursor.y, bubbles: true, cancelable: true }));
    done = to;
    if (u >= 1) return;
    await raf();
  }
};
const center = (el) => {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};
/** Move to a button and click it. */
T.click = async (el, glideMs = 450) => {
  await T.glide(...center(el), glideMs);
  cursor.pulse = performance.now();
  await sleep(90);
  el.click();
  await sleep(120);
};
/** Drag a range input's thumb to value `to` (in the input's own units). */
T.slide = async (input, to, ms = 700) => {
  const r = input.getBoundingClientRect(), min = +input.min, max = +input.max;
  const xOf = (v) => r.left + 8 + ((v - min) / (max - min)) * (r.width - 16);
  const from = +input.value;
  await T.glide(xOf(from), r.top + r.height / 2, 400);
  cursor.down = true;
  cursor.pulse = performance.now();
  const t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), v = lerp(from, to, T.smooth(u));
    input.value = String(v);
    input.dispatchEvent(new Event('input'));
    cursor.x = xOf(v);
    if (u >= 1) break;
    await raf();
  }
  cursor.down = false;
};
/** Steer the wind dial through the given points (fractions of its radius, x right, y up). */
T.steer = async (points, ms) => {
  const svg = document.querySelector('.avbd-wind svg');
  svg.setPointerCapture = () => {};
  svg.hasPointerCapture = () => true;
  const r = svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
  const at = ([u, v]) => [cx + u * R, cy - v * R];
  await T.glide(...at(points[0]), 450);
  T.press(svg);
  // One eased pass along a Catmull-Rom curve through the points: no stops at each one
  const P = points.map(at);
  const n = P.length - 1;
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  const t0 = performance.now();
  for (;;) {
    const u = Math.min((performance.now() - t0) / ms, 1), s = T.smooth(u) * n, i = Math.min(Math.floor(s), n - 1), f = s - i;
    const p = (k) => P[Math.max(0, Math.min(n, k))];
    cursor.x = cr(p(i - 1)[0], p(i)[0], p(i + 1)[0], p(i + 2)[0], f);
    cursor.y = cr(p(i - 1)[1], p(i)[1], p(i + 1)[1], p(i + 2)[1], f);
    pointer(svg, 'pointermove', cursor.x, cursor.y, true);
    if (u >= 1) break;
    await raf();
  }
  T.lift();
};

// --- Compositor ----------------------------------------------------------------------------
const comp = document.createElement('canvas');
comp.width = W;
comp.height = H;
const ctx = comp.getContext('2d');
/** Selectors of the page UI drawn into the video (per shot). */
T.ui = [];
T.labelScale = 1.7;
// Panels drawn larger for video (layout and clicks follow: zoom is real CSS)
document.querySelector('#trailer-zoom')?.remove();
const zoom = document.createElement('style');
zoom.id = 'trailer-zoom';
zoom.textContent = '.avbd-wind,.avbd-panel{zoom:1.45}';
document.head.append(zoom);
const snaps = new Map();
let frame = 0;
const inline = (src, dst) => {
  const cs = getComputedStyle(src);
  let css = '';
  for (let i = 0; i < cs.length; i++) css += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
  dst.setAttribute('style', css);
  for (let i = 0; i < src.children.length; i++) inline(src.children[i], dst.children[i]);
};
const snapshot = (el) => {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const clone = el.cloneNode(true);
  inline(el, clone);
  clone.style.position = 'static';
  clone.style.transform = 'none';
  clone.style.margin = '0';
  for (const input of clone.querySelectorAll('input[type=range]')) input.setAttribute('value', el.querySelector(`input[aria-label="${input.getAttribute('aria-label')}"]`)?.value ?? input.value);
  const s = 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width * s}" height="${r.height * s}"><foreignObject width="${r.width}" height="${r.height}" transform="scale(${s})">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
  const img = new Image();
  img.onload = () => snaps.set(el, { img, r });
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
};
const arrow = new Path2D('M0 0 L0 22 L6 16.5 L10 25.5 L13.5 24 L9.6 15.2 L17 15.2 Z');
const drawCursor = () => {
  if (!cursor.shown) return;
  const alpha = cursor.fadeAt === null ? 1 : Math.max(0, 1 - (performance.now() - cursor.fadeAt) / 300);
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  const since = performance.now() - cursor.pulse;
  // A click: a ring that grows and fades (sized to read in a phone's feed)
  if (since < 500) {
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 16 + (since / 500) * 44, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(184, 80, 63, ${0.45 * (1 - since / 500)})`;
    ctx.fill();
  }
  ctx.save();
  ctx.translate(cursor.x, cursor.y);
  ctx.scale(cursor.down ? 2.5 : 2.8, cursor.down ? 2.5 : 2.8);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#fff';
  ctx.fill(arrow);
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#1f2328';
  ctx.stroke(arrow);
  ctx.restore();
  ctx.globalAlpha = 1;
};
const compose = () => {
  ctx.drawImage(canvas, 0, 0, W, H);
  const els = T.ui.flatMap((s) => [...document.querySelectorAll(s)]).filter((el) => !el.hidden && el.style.display !== 'none');
  if (frame++ % 2 === 0) for (const el of els) snapshot(el);
  for (const el of els) {
    const snap = snaps.get(el);
    if (!snap) continue;
    // Labels follow their bodies: draw at the element's current place (labels enlarged about
    // their left edge, which sits beside the body)
    const r = el.getBoundingClientRect();
    const s = el.classList.contains('avbd-label') ? T.labelScale : 1;
    ctx.drawImage(snap.img, r.left, r.top + r.height / 2 - (snap.r.height * s) / 2, snap.r.width * s, snap.r.height * s);
  }
  drawCursor();
};
let composing = true;
(async () => {
  while (composing) {
    await raf();
    compose();
  }
})();
T.stop = () => (composing = false);

// --- Recording -----------------------------------------------------------------------------
T.record = async (name, ms, script) => {
  const stream = comp.captureStream(60);
  const rec = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.640033', videoBitsPerSecond: 40e6 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  let frames = 0, run = true, worst = 0, prev = performance.now();
  (async () => {
    while (run) {
      await raf();
      const n = performance.now();
      worst = Math.max(worst, n - prev);
      prev = n;
      frames++;
    }
  })();
  const t0 = performance.now();
  rec.start();
  await Promise.all([script(), sleep(ms)]);
  run = false;
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.stop();
  await stopped;
  const secs = (performance.now() - t0) / 1000;
  const blob = new Blob(chunks, { type: 'video/mp4' });
  await fetch(`http://127.0.0.1:8765/clip?name=${name}&ext=mp4`, { method: 'POST', body: blob });
  cursor.shown = false;
  cursor.fadeAt = null;
  T.ui = [];
  return { name, fps: +(frames / secs).toFixed(1), worstFrameMs: +worst.toFixed(1), step: document.querySelector('#timing').textContent.trim(), bodies: sim().bodyCount, mb: +(blob.size / 1e6).toFixed(1) };
};
T.snapTest = () => comp.toDataURL('image/jpeg', 0.7).length;
