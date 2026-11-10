// Native-collider contact observations for the Rapier interlocking study (STE-3282). A bounded
// diagnostic of actual attached component (convex sector) pairs at the colliders' current stored
// poses, queried with Rapier's public Collider.contactCollider. It is NOT a global compound minimum
// translation distance, a physical-correctness proof or a continuous no-pass-through guarantee: no
// returned contact only means no queried component pair was within the prediction distance at this
// instant, never a physical pass. Structural types only; no engine or solver import.

/** Rapier returns null beyond `prediction`; at 0 it returns touching/penetrating pairs (observed: occasionally a tiny positive distance, recorded as is). */
export const NATIVE_CONTACT_PREDICTION = 0;
/** Authored study sizes: sectors per ring, one floor cuboid, one peg cylinder. */
const RING_PIECES = [16, 32, 64] as const;
export const NATIVE_CONTACT_MAX_QUERIES_PER_SNAPSHOT = 64 * 64 + 4 * 64;

export interface NativeShapeContact { distance: number }
export interface NativeCollider { contactCollider(other: never, prediction: number): NativeShapeContact | null }
export interface NativeBody { handle: number; isFixed(): boolean; numColliders(): number; collider(i: number): NativeCollider }
export interface NativeStudyBodies { rings: readonly [NativeBody, NativeBody]; peg: NativeBody; floor: NativeBody; pieces: number }

export type NativePairName = 'ring-ring' | 'upper-peg' | 'lower-peg' | 'upper-floor' | 'lower-floor' | 'peg-floor';
export interface NativePairObservation {
  pair: NativePairName;
  /** observed: every enumerated component query ran with finite output; excluded: never queried by rule;
   * invalid: a query returned a non-finite distance; error: enumeration or a query threw. */
  status: 'observed' | 'excluded' | 'invalid' | 'error';
  exclusion: 'same-body' | 'fixed-fixed' | null;
  collidersA: number | null; collidersB: number | null;
  /** Component pairs enumerated (collidersA × collidersB) and queries actually completed. */
  expectedQueries: number; queries: number;
  /** Queries that returned a contact within the prediction distance (finite or not). */
  returnedContacts: number; penetratingContacts: number; nonFiniteDistances: number;
  /** Minimum finite returned signed distance (negative = penetration); null when no finite distance was returned. */
  minReturnedDistance: number | null;
  /** Positive depth of the deepest returned penetration; null when no penetrating contact was returned. */
  deepestPenetration: number | null;
  /** contact-returned / no-returned-contact only for status observed; otherwise unknown. Not a pass/fail. */
  result: 'contact-returned' | 'no-returned-contact' | 'unknown';
  error: string | null;
}
export interface NativeContactObservation {
  available: true;
  method: 'rapier Collider.contactCollider at current stored collider poses';
  prediction: number;
  pieces: number | null;
  totalQueries: number;
  pairs: NativePairObservation[];
  /** Rapier's narrowphase is not consulted; nothing is stepped or mutated by the query. */
  note: string;
}
export interface NativeContactsUnavailable { available: false; reason: string }

export const NATIVE_CONTACT_NOTE = 'Per-component diagnostic at sparse snapshots: not a global compound distance, physical proof or continuous no-pass-through guarantee; no-returned-contact is not a pass';
export const AVBD_NATIVE_CONTACTS_UNAVAILABLE = 'AVBD has no native-collider contact query for its analytic SDF fields; no equivalent value exists and none is compared with Rapier';

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

function countColliders(body: NativeBody, allowed: readonly number[]): number {
  const n = body.numColliders();
  if (!Number.isInteger(n) || !allowed.includes(n)) throw new Error(`unexpected collider count ${String(n)}`);
  return n;
}

export function observeNativePair(pair: NativePairName, a: NativeBody, b: NativeBody, allowA: readonly number[], allowB: readonly number[],
  prediction: number, describe: (e: unknown) => string): NativePairObservation {
  const o: NativePairObservation = { pair, status: 'observed', exclusion: null, collidersA: null, collidersB: null, expectedQueries: 0, queries: 0,
    returnedContacts: 0, penetratingContacts: 0, nonFiniteDistances: 0, minReturnedDistance: null, deepestPenetration: null, result: 'unknown', error: null };
  try {
    if (a.handle === b.handle) { o.status = 'excluded'; o.exclusion = 'same-body'; return o; }
    if (a.isFixed() && b.isFixed()) { o.status = 'excluded'; o.exclusion = 'fixed-fixed'; return o; }
    const na = o.collidersA = countColliders(a, allowA), nb = o.collidersB = countColliders(b, allowB);
    o.expectedQueries = na * nb;
    for (let i = 0; i < na; i++) {
      const ca = a.collider(i);
      for (let j = 0; j < nb; j++) {
        const contact = ca.contactCollider(b.collider(j) as never, prediction);
        o.queries++;
        if (contact === null) continue;
        if (contact === undefined) throw new Error('native collider query returned undefined instead of contact or null');
        o.returnedContacts++;
        const d = contact.distance;
        if (typeof d !== 'number' || !Number.isFinite(d)) { o.nonFiniteDistances++; continue; }
        if (o.minReturnedDistance === null || d < o.minReturnedDistance) o.minReturnedDistance = d;
        if (d < 0) { o.penetratingContacts++; o.deepestPenetration = Math.max(o.deepestPenetration ?? 0, -d); }
      }
    }
    if (o.nonFiniteDistances > 0) o.status = 'invalid';
    else o.result = o.returnedContacts > 0 ? 'contact-returned' : 'no-returned-contact';
  } catch (e) { o.status = 'error'; o.error = describe(e); o.result = 'unknown'; }
  return o;
}

/** Query every attached sector pair of ring-ring and each ring vs peg and floor at the current stored
 * collider poses. Never steps or mutates; an enumeration or query failure makes only its pair `error`
 * (a non-finite or negative prediction is a caller error and is refused). */
export function observeNativeContacts(study: NativeStudyBodies, options: { prediction?: number; describeError?: (e: unknown) => string } = {}): NativeContactObservation {
  const prediction = options.prediction ?? NATIVE_CONTACT_PREDICTION, describe = options.describeError ?? firstLine;
  if (!Number.isFinite(prediction) || prediction < 0) throw new Error('prediction must be a finite non-negative distance');
  const pieces = (RING_PIECES as readonly number[]).includes(study.pieces) ? study.pieces : null;
  const ring = pieces === null ? [] : [pieces], one = [1];
  const [upper, lower] = study.rings;
  const pairs = [
    observeNativePair('ring-ring', upper, lower, ring, ring, prediction, describe),
    observeNativePair('upper-peg', upper, study.peg, ring, one, prediction, describe),
    observeNativePair('lower-peg', lower, study.peg, ring, one, prediction, describe),
    observeNativePair('upper-floor', upper, study.floor, ring, one, prediction, describe),
    observeNativePair('lower-floor', lower, study.floor, ring, one, prediction, describe),
    observeNativePair('peg-floor', study.peg, study.floor, one, one, prediction, describe),
  ];
  return { available: true, method: 'rapier Collider.contactCollider at current stored collider poses', prediction, pieces,
    totalQueries: pairs.reduce((n, p) => n + p.queries, 0), pairs, note: NATIVE_CONTACT_NOTE };
}
