import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advancePlayhead, checkTrackBytes, describeCapture, f32Short, parsePoseTrack, PoseTrackError, POSE_FLOATS, POSE_TRACK_SCHEMA, POSE_TRACK_UNITS,
  samplePoses, serializeWithOutputBytes, TRACK_LIMITS, trackDuration, utf8Length,
} from '../examples/pose-track.ts';

const IDENTITY = [0, 0, 0, 1];
/** A valid track as plain JSON: a fixed floor and one falling sphere, frames at the given steps. */
function raw(steps = [0, 1, 2], extra: Record<string, unknown> = {}) {
  return {
    schema: POSE_TRACK_SCHEMA, units: { ...POSE_TRACK_UNITS }, dt: 0.5,
    bodies: [{ id: 1, shape: 'box', size: [10, 1, 10], fixed: true }, { id: 2, shape: 'sphere', size: [1, 1, 1], fixed: false }],
    frames: steps.map(step => ({ step, poses: [[0, -0.5, 0, ...IDENTITY], [0, 10 - 2 * step, 0, ...IDENTITY]] })),
    ...extra,
  } as Record<string, any>;
}
const text = (v: unknown) => JSON.stringify(v);
const rejects = (v: unknown, pattern: RegExp, label = pattern.source) => assert.throws(() => parsePoseTrack(typeof v === 'string' ? v : text(v)), (e: unknown) => e instanceof PoseTrackError && pattern.test(e.message), label);

test('a valid track parses into bounded, frame-major arrays', () => {
  const track = parsePoseTrack(text(raw()));
  assert.equal(track.dt, 0.5);
  assert.deepEqual(track.bodies.map(b => [b.id, b.shape, b.fixed]), [[1, 'box', true], [2, 'sphere', false]]);
  assert.deepEqual([...track.steps], [0, 1, 2]);
  assert.equal(track.poses.length, 3 * 2 * POSE_FLOATS);
  assert.equal(track.poses[(2 * 2 + 1) * POSE_FLOATS + 1], 6, 'frame 2, body 2, y');
  assert.equal(track.capture, null);
  assert.equal(trackDuration(track), 1);
  assert.deepEqual(parsePoseTrack(text(raw([0], { capture: { tool: 'x' } }))).capture, { tool: 'x' });
});

test('foreign, truncated and non-object input is refused', () => {
  const good = text(raw());
  rejects(good.slice(0, good.length >> 1), /not valid JSON/, 'truncated');
  rejects(good.slice(0, -1), /not valid JSON/, 'last brace missing');
  rejects('', /not valid JSON/);
  rejects('[]', /expected a JSON object/);
  rejects('null', /expected a JSON object/);
  rejects('"x"', /expected a JSON object/);
  rejects({ ...raw(), schema: 'three-avbd/interlocking-trial/v1' }, /Not a pose track/, 'another report of this repository');
  rejects({ ...raw(), schema: undefined }, /Not a pose track/);
  rejects({ ...raw(), schema: `${POSE_TRACK_SCHEMA}x` }, /Not a pose track/);
  rejects('[' .repeat(200000), /not valid JSON/, 'absurd nesting is a parse failure, not a crash');
  rejects({ ...raw(), extra: 1 }, /unknown field "extra"/);
  rejects({ ...raw(), bodies: [{ ...raw().bodies[0], mass: 1 }, raw().bodies[1]] }, /unknown field "mass"/);
  rejects({ ...raw(), capture: [] }, /capture must be an object/);
  rejects({ ...raw(), capture: 'x' }, /capture must be an object/);
});

test('size limits are enforced before the JSON is parsed', () => {
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed++; return parse(...args); }) as typeof JSON.parse;
  try {
    rejects('x'.repeat(TRACK_LIMITS.maxBytes + 1), /limit is/, 'text over the byte limit');
    rejects('é'.repeat(TRACK_LIMITS.maxBytes / 2 + 1), /limit is/, 'multi-byte text over the limit although shorter in characters');
    assert.equal(parsed, 0, 'no JSON.parse for an oversized text');
    parsePoseTrack(text(raw()));
    assert.equal(parsed, 1);
  } finally { JSON.parse = parse; }
  assert.throws(() => checkTrackBytes(TRACK_LIMITS.maxBytes + 1), PoseTrackError);
  assert.throws(() => checkTrackBytes(NaN), PoseTrackError);
  assert.throws(() => checkTrackBytes(-1), PoseTrackError);
  checkTrackBytes(TRACK_LIMITS.maxBytes);
  assert.equal(utf8Length('aé€😀'), 1 + 2 + 3 + 4);
  assert.equal(utf8Length('\ud800'), 3, 'a lone surrogate counts as the 3 bytes JSON.stringify/TextEncoder replace it with');
  // The ceiling scene (64 bodies × 301 frames of f32 poses) fits the byte limit with room to spare
  const f = (i: number) => [f32Short(-123.456789 * i), f32Short(98.7654321 / (i + 1)), f32Short(0.123456789), 0.5, 0.5, -0.5, 0.5];
  const frames = Array.from({ length: TRACK_LIMITS.maxFrames }, (_, step) => ({ step, poses: Array.from({ length: TRACK_LIMITS.maxBodies }, (_, i) => f(step + i)) }));
  const biggest = { ...raw(), bodies: Array.from({ length: TRACK_LIMITS.maxBodies }, (_, i) => ({ id: i + 1, shape: 'box', size: [1, 1, 1], fixed: false })), frames };
  const bytes = utf8Length(text(biggest));
  assert.ok(bytes < TRACK_LIMITS.maxBytes / 2, `${bytes} bytes`);
  assert.equal(parsePoseTrack(text(biggest)).poses.length, TRACK_LIMITS.maxFrames * TRACK_LIMITS.maxBodies * POSE_FLOATS);
});

test('counts are bounded and must agree', () => {
  const body = (id: number) => ({ id, shape: 'box', size: [1, 1, 1], fixed: false });
  rejects({ ...raw(), bodies: [] }, /bodies must be a list of 1 to 64/);
  rejects({ ...raw(), bodies: Array.from({ length: 65 }, (_, i) => body(i + 1)) }, /bodies must be a list of 1 to 64/);
  rejects({ ...raw(), bodies: 'two' }, /bodies must be a list/);
  rejects({ ...raw(), frames: [] }, /frames must be a list of 1 to 301/);
  rejects({ ...raw(), frames: Array.from({ length: 302 }, (_, step) => ({ step, poses: [] })) }, /frames must be a list of 1 to 301/, 'one more frame than 300 steps allow');
  rejects({ ...raw(), frames: null }, /frames must be a list/);
  const r = raw(); r.frames[1].poses.pop();
  rejects(r, /frames\[1\]: expected 2 poses \(one per body\), found 1/, 'a pose short');
  const extraPose = raw(); extraPose.frames[0].poses.push([0, 0, 0, ...IDENTITY]);
  rejects(extraPose, /frames\[0\]: expected 2 poses \(one per body\), found 3/);
  const missing = raw(); delete missing.frames[2].poses;
  rejects(missing, /frames\[2\]: expected 2 poses/);
  const shortPose = raw(); shortPose.frames[0].poses[1] = [0, 0, 0, 0, 0, 1];
  rejects(shortPose, /poses\[1\]: expected 7 numbers/);
  const longPose = raw(); longPose.frames[0].poses[1] = [0, 0, 0, 0, 0, 0, 1, 9];
  rejects(longPose, /expected 7 numbers/);
});

test('bodies: unique ids, supported shapes, positive bounded sizes', () => {
  const b = (patch: Record<string, unknown>) => ({ ...raw(), bodies: [{ ...raw().bodies[0], ...patch }, raw().bodies[1]] });
  rejects({ ...raw(), bodies: [raw().bodies[0], { ...raw().bodies[1], id: 1 }] }, /duplicate id 1/);
  for (const id of [0, -1, 1.5, 2 ** 31, '3', null, NaN]) rejects(b({ id }), /id must be an integer/, `id ${id}`);
  for (const shape of ['capsule', 'hull', 'Box', 1, undefined]) rejects(b({ shape }), /shape must be/, `shape ${String(shape)}`);
  for (const size of [[1, 1], [1, 1, 1, 1], [0, 1, 1], [-1, 1, 1], [1, 1, TRACK_LIMITS.maxSize + 1], ['1', 1, 1], [null, 1, 1], 'big', undefined]) rejects(b({ size }), /size must be three numbers/, `size ${JSON.stringify(size)}`);
  rejects({ ...raw(), bodies: [raw().bodies[0], { ...raw().bodies[1], size: [1, 1, 2] }] }, /sphere's size is its diameter/);
  for (const fixed of [1, 'true', null, undefined]) rejects(b({ fixed }), /fixed must be true or false/);
  rejects({ ...raw(), bodies: [null, raw().bodies[1]] }, /bodies\[0\]: expected an object/);
});

test('dt, units and steps', () => {
  for (const dt of [0, -1 / 60, null, '0.016', TRACK_LIMITS.maxDt + 1e-9, undefined]) rejects({ ...raw(), dt }, /dt must be/, `dt ${String(dt)}`);
  rejects(text(raw()).replace('"dt":0.5', '"dt":1e999'), /dt must be/, 'overflow to Infinity');
  rejects({ ...raw(), units: { ...POSE_TRACK_UNITS, length: 'foot' } }, /units must be exactly/);
  rejects({ ...raw(), units: { ...POSE_TRACK_UNITS, up: '+z' } }, /units must be exactly/);
  rejects({ ...raw(), units: { ...POSE_TRACK_UNITS, extra: 1 } }, /units must be exactly/);
  rejects({ ...raw(), units: undefined }, /units must be exactly/);
  rejects(raw([0, 2, 2]), /steps must increase \(2 follows 2\)/);
  rejects(raw([3, 2]), /steps must increase/);
  rejects(raw([-1, 0]), /step must be a whole number/);
  rejects(raw([0.5, 1]), /step must be a whole number/);
  rejects(raw([0, 1e9 + 1]), /step must be a whole number/);
  assert.deepEqual([...parsePoseTrack(text(raw([5, 9, 40]))).steps], [5, 9, 40], 'a gap or a non-zero start is allowed; it is recorded as read');
});

test('poses: finite, bounded positions and valid unit quaternions', () => {
  const withPose = (pose: unknown[]) => { const r = raw(); r.frames[1].poses[1] = pose; return r; };
  rejects(text(withPose([0, 0, 0, ...IDENTITY])).replace('[0,0,0,0,0,0,1]', '[0,1e999,0,0,0,0,1]'), /position must be finite/, 'overflow to Infinity');
  for (const bad of [null, 'NaN', '1', {}, [], true]) rejects(withPose([bad, 0, 0, ...IDENTITY]), /position must be finite/, `position ${JSON.stringify(bad)}`);
  rejects(withPose([TRACK_LIMITS.maxCoordinate + 1, 0, 0, ...IDENTITY]), /within ±/);
  rejects(withPose([0, -TRACK_LIMITS.maxCoordinate - 1, 0, ...IDENTITY]), /within ±/);
  rejects(withPose([0, 0, 0, null, 0, 0, 1]), /rotation must be finite/);
  rejects(withPose([0, 0, 0, 0, 0, 0, 0]), /unit quaternion/, 'zero quaternion');
  rejects(withPose([0, 0, 0, 1, 1, 1, 1]), /unit quaternion/, 'length 2');
  rejects(withPose([0, 0, 0, 0, 0, 0, 1.01]), /unit quaternion/);
  rejects(withPose([0, 0, 0, 0, 0, 0, 0.5]), /unit quaternion/);
  const overflow = text(withPose([0, 0, 0, 0, 0, 0, 1])).replace('[0,0,0,0,0,0,1]', '[0,0,0,1e200,1e200,0,1]');
  rejects(overflow, /unit quaternion/, 'a squared length that overflows is not 1');
  // An f32 readback and a hand-normalized quaternion both pass
  parsePoseTrack(text(withPose([1, 2, 3, f32Short(0.1), f32Short(0.2), f32Short(0.3), f32Short(Math.sqrt(1 - 0.01 - 0.04 - 0.09))])));
  parsePoseTrack(text(withPose([0, 0, 0, 0, 0, 0, -1])));
});

test('sampling: exact frames at the endpoints, linear between, clamped outside, never non-finite', () => {
  const track = parsePoseTrack(text(raw([0, 1, 2])));
  const out = new Float64Array(2 * POSE_FLOATS), y = () => out[POSE_FLOATS + 1];
  assert.equal(trackDuration(track), 1);
  samplePoses(track, 0, out); assert.equal(y(), 10);
  samplePoses(track, 0.5, out); assert.equal(y(), 8, 'frame 1 at t = dt');
  samplePoses(track, 0.25, out); assert.equal(y(), 9, 'half way to frame 1');
  samplePoses(track, 0.75, out); assert.equal(y(), 7);
  samplePoses(track, 1, out); assert.equal(y(), 6, 'the last frame, exactly');
  samplePoses(track, 99, out); assert.equal(y(), 6, 'clamped to the end');
  samplePoses(track, -5, out); assert.equal(y(), 10, 'clamped to the start');
  assert.equal(out[1], -0.5, 'the fixed floor stays put');
  for (const t of [NaN, Infinity, -Infinity]) assert.throws(() => samplePoses(track, t, out), RangeError);
  assert.throws(() => samplePoses(track, 0, new Float64Array(3)), RangeError);
  for (let t = -0.1; t < 1.2; t += 0.037) { samplePoses(track, t, out); assert.ok(out.every(Number.isFinite)); }
});

test('sampling follows the steps frames were read at, not their index', () => {
  const track = parsePoseTrack(text(raw([10, 12, 16])));
  const out = new Float64Array(2 * POSE_FLOATS);
  assert.equal(trackDuration(track), 3);
  samplePoses(track, 0, out); assert.equal(out[POSE_FLOATS + 1], 10 - 2 * 10);
  samplePoses(track, 1, out); assert.equal(out[POSE_FLOATS + 1], 10 - 2 * 12, 'step 12 is 2 steps × dt = 1 s after step 10');
  samplePoses(track, 1.5, out); assert.equal(out[POSE_FLOATS + 1], -16, 'step 13 is a quarter of the way from step 12 to step 16: -14 + (-22 + 14) / 4');
  const single = parsePoseTrack(text(raw([7])));
  assert.equal(trackDuration(single), 0);
  samplePoses(single, 0.3, out); assert.equal(out[POSE_FLOATS + 1], 10 - 14, 'a one-frame track holds its frame');
});

test('sampling rotations: shortest path, unit length, opposite quaternions are the same rotation', () => {
  const s = Math.SQRT1_2;
  const two = (q0: number[], q1: number[]) => {
    const r = raw([0, 1]);
    r.frames[0].poses[1] = [0, 0, 0, ...q0]; r.frames[1].poses[1] = [0, 0, 0, ...q1];
    return parsePoseTrack(text(r));
  };
  const out = new Float64Array(2 * POSE_FLOATS), q = () => [...out.subarray(POSE_FLOATS + 3, POSE_FLOATS + 7)];
  // A quarter turn about y, half way: an eighth turn
  samplePoses(two(IDENTITY, [0, s, 0, s]), 0.25, out);
  const eighth = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  q().forEach((v, i) => assert.ok(Math.abs(v - eighth[i]) < 0.02, `component ${i}: ${v}`));
  assert.ok(Math.abs(Math.hypot(...q()) - 1) < 1e-12);
  // q and -q: the second frame is the same rotation, so the blend must not collapse through zero
  samplePoses(two(IDENTITY, [0, 0, 0, -1]), 0.25, out);
  assert.ok(Math.abs(Math.hypot(...q()) - 1) < 1e-12);
  assert.ok(Math.abs(Math.abs(q()[3]) - 1) < 1e-12);
  // Exactly opposite blended half way cancel to nothing on the long path; the short path must not produce NaN
  samplePoses(two(IDENTITY, [0, 0, 0, -1]), 0.5, out);
  assert.ok(out.every(Number.isFinite));
});

test('playhead: advances, loops, stops at the end, ignores bad input', () => {
  assert.equal(advancePlayhead(0, 0.25, 1, true), 0.25);
  assert.ok(Math.abs(advancePlayhead(0.9, 0.25, 1, true) - 0.15) < 1e-12);
  assert.equal(advancePlayhead(0.9, 0.25, 1, false), 1);
  assert.equal(advancePlayhead(1, 0.1, 1, false), 1);
  assert.equal(advancePlayhead(0.5, 5.25, 1, true), 0.75, 'more than a whole loop in one go');
  assert.equal(advancePlayhead(0.5, 1, 1, true), 0.5, 'exactly one loop');
  assert.equal(advancePlayhead(0.5, 0.5, 1, true), 0, 'reaching the end wraps to the start');
  for (const bad of [NaN, Infinity, -Infinity, -1, 0]) assert.equal(advancePlayhead(0.4, bad, 1, true), 0.4, `delta ${bad}`);
  assert.equal(advancePlayhead(NaN, 0.1, 1, true), 0.1, 'a bad playhead restarts');
  assert.equal(advancePlayhead(-3, 0.1, 1, true), 0.1);
  assert.equal(advancePlayhead(9, 0.1, 1, false), 1, 'clamped into range');
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(advancePlayhead(0.4, 0.1, duration, true), 0, `duration ${duration}`);
  const huge = advancePlayhead(Number.MAX_VALUE / 2, Number.MAX_VALUE, Number.MAX_VALUE, true);
  assert.ok(Number.isFinite(huge) && huge >= 0 && huge <= Number.MAX_VALUE, 'finite inputs must not overflow the looping playhead');
});

test('sparse frames cannot bypass the simulated-step ceiling', () => {
  rejects(raw([0, TRACK_LIMITS.maxSteps + 1]), /span.*300/, 'two frames still cannot describe an unbounded simulation');
  rejects(raw([100, 100 + TRACK_LIMITS.maxSteps + 1]), /span.*300/, 'a nonzero start must have the same bound');
  parsePoseTrack(text(raw([100, 100 + TRACK_LIMITS.maxSteps])));
});

test('capture description keeps only safe, clipped facts', () => {
  assert.equal(describeCapture(null), null);
  const d = describeCapture({ tool: 'x'.repeat(500), device: { vendor: 'apple\u0000‮', architecture: { evil: 1 } }, config: { steps: 120, iterations: '10' },
    timing: { captureWallMs: 12.5, readbackWallMs: Infinity }, outputBytes: 1234 })!;
  assert.equal(d.tool!.length, 60);
  assert.equal(d.vendor, 'apple??');
  assert.equal(d.architecture, null);
  assert.deepEqual([d.steps, d.iterations, d.captureWallMs, d.readbackWallMs, d.outputBytes], [120, null, 12.5, null, 1234]);
  assert.deepEqual(describeCapture({}), { tool: null, vendor: null, architecture: null, steps: null, iterations: null, captureWallMs: null, readbackWallMs: null, outputBytes: null });
});

test('output bytes: the stamped size is the exact size of the text, and f32 rounding keeps the f32', () => {
  for (const frames of [1, 7, 200]) {
    const base = raw(Array.from({ length: frames }, (_, i) => i), { capture: { tool: 't' } }) as { capture: Record<string, unknown> } & Record<string, unknown>;
    const { text: out, bytes } = serializeWithOutputBytes(base);
    assert.equal(utf8Length(out), bytes);
    const parsed = parsePoseTrack(out);
    assert.equal(parsed.capture!.outputBytes, bytes);
  }
  for (const v of [0.1, -1 / 3, 123.456789, 1e-7, 3.4e38, 0]) {
    const f = f32Short(v);
    assert.equal(Math.fround(f), Math.fround(v), `${v}`);
    assert.ok(String(f).length <= 16);
  }
});
