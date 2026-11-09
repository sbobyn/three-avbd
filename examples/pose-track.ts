// A pose track: rigid-body transforms captured from a headless World, for a physics-free player.
//
// EXAMPLE-LOCAL AND PROVISIONAL. This is not a three-avbd file format, not an exported package entry, not a
// World snapshot and not a replay: it holds each body's id, shape, size and, per captured step, its position and
// unit quaternion. No velocities, joints, contacts, events or editable world state; nothing can be restored from it.
// Pure code (no Node, DOM or Three.js import) so the capture script and the browser player share one validator.

export const POSE_TRACK_SCHEMA = 'three-avbd.example.pose-track/v0-provisional';

/** Hard ceilings, checked before anything is allocated. A larger scene is a different tool, not a bigger number here. */
export const TRACK_LIMITS = {
  /** Tracked bodies, fixed ones included. */
  maxBodies: 64,
  /** Simulated steps; frame 0 (before the first step) comes on top. */
  maxSteps: 300,
  maxFrames: 301,
  /** Serialized size. The ceiling bodies × frames × 7 numbers needs about 3 MB; this leaves room for the capture record. */
  maxBytes: 8 * 1024 * 1024,
  /** Largest |coordinate| (m), largest box width or sphere diameter (m), largest dt (s). */
  maxCoordinate: 1e6,
  maxSize: 1e3,
  maxDt: 1,
  /** How far from 1 a quaternion's length may be (f32 readbacks are well inside). */
  quaternionTolerance: 1e-3,
} as const;

export const POSE_TRACK_UNITS = { length: 'metre', time: 'second', up: '+y', rotation: 'unit quaternion [x, y, z, w]' } as const;
/** Numbers per pose in `frames[].poses[]`: position x y z, then quaternion x y z w. */
export const POSE_FLOATS = 7;

export interface TrackBody { id: number; shape: 'box' | 'sphere'; /** Full widths (m); a sphere's diameter on every axis. */ size: [number, number, number]; fixed: boolean }

/** A validated track. `poses` is frame-major: ((frame * bodies.length) + body) * 7 + [px py pz qx qy qz qw]. */
export interface PoseTrack {
  dt: number;
  bodies: readonly TrackBody[];
  /** The World step each frame was read at (strictly increasing). */
  steps: Float64Array;
  poses: Float64Array;
  /** The capture record exactly as the file carried it, or null for a file without one. Unvalidated beyond being a plain object. */
  capture: Record<string, unknown> | null;
}

export class PoseTrackError extends Error {
  constructor(message: string) { super(message); this.name = 'PoseTrackError'; }
}

const TOP_KEYS = new Set(['schema', 'scope', 'units', 'dt', 'bodies', 'frames', 'capture']);
const BODY_KEYS = new Set(['id', 'shape', 'size', 'fixed']);
const FRAME_KEYS = new Set(['step', 'poses']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function fail(message: string): never { throw new PoseTrackError(message); }
/** `number` and not NaN/Infinity (JSON.parse turns 1e999 into Infinity, so this is not redundant). */
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, what: string) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${what}: unknown field "${key.slice(0, 40)}"`);
}

/** UTF-8 length without encoding the string. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** Refuse a file by its size before reading it (File.size in the player, stat in the script). */
export function checkTrackBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) fail('Pose track: unknown file size');
  if (bytes > TRACK_LIMITS.maxBytes) fail(`Pose track is ${bytes} bytes; the limit is ${TRACK_LIMITS.maxBytes}`);
}

/**
 * Parse and validate a track. Order: size of the text, then JSON, then the counts (bodies, frames) against the
 * ceilings, and only then every number; the typed arrays are allocated last, once every count is known to be bounded
 * and consistent. Throws PoseTrackError with a short message that never echoes file content beyond a few characters.
 */
export function parsePoseTrack(text: string): PoseTrack {
  if (typeof text !== 'string') fail('Pose track: expected text');
  // A UTF-16 length is never more than the byte length: this rejects an oversized string without scanning it
  if (text.length > TRACK_LIMITS.maxBytes) checkTrackBytes(text.length);
  checkTrackBytes(utf8Length(text));
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('Pose track is not valid JSON (truncated or corrupt?)'); }
  if (!isRecord(value)) return fail('Pose track: expected a JSON object');
  if (value.schema !== POSE_TRACK_SCHEMA) return fail(`Not a pose track: schema is not ${POSE_TRACK_SCHEMA}`);
  checkKeys(value, TOP_KEYS, 'Pose track');

  const units = value.units;
  if (!isRecord(units) || Object.keys(units).length !== 4 || (Object.keys(POSE_TRACK_UNITS) as (keyof typeof POSE_TRACK_UNITS)[]).some(k => units[k] !== POSE_TRACK_UNITS[k])) {
    fail('Pose track: units must be exactly metres, seconds, y-up and [x, y, z, w] quaternions');
  }
  const dt = value.dt;
  if (!finite(dt) || dt <= 0 || dt > TRACK_LIMITS.maxDt) fail(`Pose track: dt must be a number above 0 and at most ${TRACK_LIMITS.maxDt}`);

  // Counts first
  const bodiesIn = value.bodies, framesIn = value.frames;
  if (!Array.isArray(bodiesIn) || bodiesIn.length < 1 || bodiesIn.length > TRACK_LIMITS.maxBodies) fail(`Pose track: bodies must be a list of 1 to ${TRACK_LIMITS.maxBodies}`);
  if (!Array.isArray(framesIn) || framesIn.length < 1 || framesIn.length > TRACK_LIMITS.maxFrames) fail(`Pose track: frames must be a list of 1 to ${TRACK_LIMITS.maxFrames}`);
  const nBodies = (bodiesIn as unknown[]).length, nFrames = (framesIn as unknown[]).length;

  const bodies: TrackBody[] = [], seen = new Set<number>();
  (bodiesIn as unknown[]).forEach((b, i) => {
    const at = `bodies[${i}]`;
    if (!isRecord(b)) return fail(`${at}: expected an object`);
    checkKeys(b, BODY_KEYS, at);
    if (typeof b.id !== 'number' || !Number.isSafeInteger(b.id) || b.id < 1 || b.id > 0x7fffffff) fail(`${at}: id must be an integer from 1 to 2147483647`);
    if (seen.has(b.id as number)) fail(`${at}: duplicate id ${b.id}`);
    seen.add(b.id as number);
    if (b.shape !== 'box' && b.shape !== 'sphere') fail(`${at}: shape must be "box" or "sphere"`);
    const size = b.size;
    if (!Array.isArray(size) || size.length !== 3 || !size.every(v => finite(v) && v > 0 && v <= TRACK_LIMITS.maxSize)) fail(`${at}: size must be three numbers above 0 and at most ${TRACK_LIMITS.maxSize}`);
    if (b.shape === 'sphere' && !((size as number[])[0] === (size as number[])[1] && (size as number[])[1] === (size as number[])[2])) fail(`${at}: a sphere's size is its diameter on all three axes`);
    if (typeof b.fixed !== 'boolean') fail(`${at}: fixed must be true or false`);
    bodies.push({ id: b.id as number, shape: b.shape as 'box' | 'sphere', size: [...(size as number[])] as [number, number, number], fixed: b.fixed });
  });

  // Every frame is checked against the counts above before any array is allocated, so a bad track allocates nothing large
  const lastStep = { value: -1 };
  (framesIn as unknown[]).forEach((f, i) => {
    const at = `frames[${i}]`;
    if (!isRecord(f)) return fail(`${at}: expected an object`);
    checkKeys(f, FRAME_KEYS, at);
    if (typeof f.step !== 'number' || !Number.isSafeInteger(f.step) || f.step < 0 || f.step > 1e9) fail(`${at}: step must be a whole number from 0 to 1e9`);
    if ((f.step as number) <= lastStep.value) fail(`${at}: steps must increase (${f.step} follows ${lastStep.value})`);
    lastStep.value = f.step as number;
    const poses = f.poses;
    if (!Array.isArray(poses) || poses.length !== nBodies) fail(`${at}: expected ${nBodies} poses (one per body), found ${Array.isArray(poses) ? poses.length : 'none'}`);
    (poses as unknown[]).forEach((p, j) => {
      const where = `${at}.poses[${j}]`;
      if (!Array.isArray(p) || p.length !== POSE_FLOATS) return fail(`${where}: expected ${POSE_FLOATS} numbers (x y z, then quaternion x y z w)`);
      for (let k = 0; k < 3; k++) if (!finite(p[k]) || Math.abs(p[k]) > TRACK_LIMITS.maxCoordinate) fail(`${where}: position must be finite and within ±${TRACK_LIMITS.maxCoordinate} m`);
      for (let k = 3; k < 7; k++) if (!finite(p[k])) fail(`${where}: rotation must be finite`);
      const length = Math.hypot(p[3], p[4], p[5], p[6]);
      if (!(Math.abs(length - 1) <= TRACK_LIMITS.quaternionTolerance)) fail(`${where}: rotation must be a unit quaternion (length ${Number.isFinite(length) ? length.toPrecision(4) : 'not finite'})`);
    });
  });

  const firstStep = (framesIn as { step: number }[])[0].step;
  if (lastStep.value - firstStep > TRACK_LIMITS.maxSteps) fail(`Pose track: frame span must not exceed ${TRACK_LIMITS.maxSteps} steps`);

  let capture: Record<string, unknown> | null = null;
  if (value.capture !== undefined) {
    if (!isRecord(value.capture)) fail('Pose track: capture must be an object when present');
    capture = value.capture as Record<string, unknown>;
  }

  const steps = new Float64Array(nFrames), poses = new Float64Array(nFrames * nBodies * POSE_FLOATS);
  (framesIn as { step: number; poses: number[][] }[]).forEach((f, i) => {
    steps[i] = f.step;
    f.poses.forEach((p, j) => poses.set(p, (i * nBodies + j) * POSE_FLOATS));
  });
  return { dt: dt as number, bodies, steps, poses, capture };
}

// ---- sampling -----------------------------------------------------------------------------------

/** Seconds from the first frame to the last, by the steps the frames were read at. */
export function trackDuration(track: PoseTrack): number {
  return (track.steps[track.steps.length - 1] - track.steps[0]) * track.dt;
}

/**
 * Move a playhead (seconds) by `delta`. Non-finite or negative deltas move nothing. Looping wraps past the end; otherwise it
 * stops at the end. The result is always finite and within [0, duration].
 */
export function advancePlayhead(time: number, delta: number, duration: number, loop: boolean): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const t = Number.isFinite(time) ? Math.min(Math.max(time, 0), duration) : 0;
  const d = Number.isFinite(delta) && delta > 0 ? delta : 0;
  if (!loop) return Math.min(t + d, duration);
  // Reduce before adding: even two finite values can overflow when summed.
  const advance = d % duration, remaining = duration - t;
  return advance < remaining ? t + advance : advance - remaining;
}

/**
 * Write the interpolated poses at `time` (clamped into the track) into `out` (bodies × 7), without allocating.
 * Positions are linear, rotations the normalized shortest-path blend (frames are one step apart, so the arc is short).
 * Equal times of the endpoints return the exact frame. Throws on a non-finite time or a wrong-size `out`.
 */
export function samplePoses(track: PoseTrack, time: number, out: Float64Array): void {
  const n = track.bodies.length, steps = track.steps, frames = steps.length;
  if (!Number.isFinite(time)) throw new RangeError('samplePoses: time must be finite');
  if (out.length !== n * POSE_FLOATS) throw new RangeError('samplePoses: out must hold bodies × 7 numbers');
  const first = steps[0], span = (steps[frames - 1] - first) * track.dt;
  const t = Math.min(Math.max(time, 0), span);
  // Last frame whose time is <= t (binary search over step numbers)
  const target = first + t / track.dt;
  let lo = 0, hi = frames - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (steps[mid] <= target) lo = mid; else hi = mid - 1; }
  const a = lo * n * POSE_FLOATS;
  if (lo === frames - 1 || target <= steps[lo]) { out.set(track.poses.subarray(a, a + n * POSE_FLOATS)); return; }
  const b = a + n * POSE_FLOATS, f = (target - steps[lo]) / (steps[lo + 1] - steps[lo]), p = track.poses;
  for (let i = 0; i < n; i++) {
    const o = i * POSE_FLOATS, x = a + o, y = b + o;
    for (let k = 0; k < 3; k++) out[o + k] = p[x + k] + (p[y + k] - p[x + k]) * f;
    const dot = p[x + 3] * p[y + 3] + p[x + 4] * p[y + 4] + p[x + 5] * p[y + 5] + p[x + 6] * p[y + 6], s = dot < 0 ? -1 : 1;
    let length = 0;
    for (let k = 3; k < 7; k++) { out[o + k] = p[x + k] + (s * p[y + k] - p[x + k]) * f; length += out[o + k] * out[o + k]; }
    length = Math.sqrt(length);
    // Opposite quaternions half-way cancel to zero: keep the earlier frame's rotation
    for (let k = 3; k < 7; k++) out[o + k] = length > 1e-9 ? out[o + k] / length : p[x + k];
  }
}

// ---- display and output helpers -----------------------------------------------------------------

const clip = (v: unknown, n = 60) => typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '?').slice(0, n) : null;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const field = (v: unknown, key: string): unknown => isRecord(v) ? v[key] : undefined;

/** A few safe facts from a capture record for display: strings clipped and ASCII-only, numbers finite, anything else dropped. */
export function describeCapture(capture: Record<string, unknown> | null) {
  if (!capture) return null;
  const device = field(capture, 'device'), timing = field(capture, 'timing'), config = field(capture, 'config');
  return {
    tool: clip(capture.tool),
    vendor: clip(field(device, 'vendor')), architecture: clip(field(device, 'architecture')),
    steps: num(field(config, 'steps')), iterations: num(field(config, 'iterations')),
    captureWallMs: num(field(timing, 'captureWallMs')), readbackWallMs: num(field(timing, 'readbackWallMs')),
    outputBytes: num(capture.outputBytes),
  };
}

/** Round to the 9 significant digits a float32 needs, so a f32 readback prints short and reads back as the same f32. */
export const f32Short = (v: number): number => Number(Math.fround(v).toPrecision(9));

/**
 * Serialize a track whose capture record gets its own final `outputBytes`: the size depends on the digits of the size, so
 * this iterates to the fixed point (a few rounds at most) and returns the text whose UTF-8 length is exactly that number.
 */
export function serializeWithOutputBytes(track: { capture: Record<string, unknown> } & Record<string, unknown>): { text: string; bytes: number } {
  let guess = 0;
  for (let round = 0; round < 8; round++) {
    const text = JSON.stringify({ ...track, capture: { ...track.capture, outputBytes: guess } });
    const bytes = utf8Length(text);
    if (bytes === guess) return { text, bytes };
    guess = bytes;
  }
  throw new Error('outputBytes did not settle');
}
