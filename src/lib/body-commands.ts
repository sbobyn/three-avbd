// Pure field validation and observation ordering shared by body commands and CPU tests.
export const bodyFields = ['position', 'rotation', 'velocity', 'angularVelocity'] as const;
export type BodyField = typeof bodyFields[number];
export type BodyPatch = Partial<Record<BodyField, number[]>>;

export function copyBodyPatch(input: BodyPatch): BodyPatch {
  const patch: BodyPatch = {};
  for (const field of bodyFields) {
    const value = input[field];
    if (value === undefined) continue;
    const length = field === 'rotation' ? 4 : 3;
    if (value.length !== length || !Array.from(value).every(v => Number.isFinite(v) && Number.isFinite(Math.fround(v)))) throw new Error(`Invalid body ${field}`);
    const copy = Array.from(value);
    if (field === 'rotation') {
      const norm = Math.hypot(...copy);
      if (!norm) throw new Error('Invalid body rotation');
      for (let i = 0; i < 4; i++) copy[i] /= norm;
    }
    patch[field] = copy;
  }
  return patch;
}

export function observedField(assigned: number[], revision: number, observed: ArrayLike<number>, readRevision: number): number[] {
  return readRevision >= revision ? Array.from(observed) : [...assigned];
}

/** Merge assigned fields without giving omitted fields a newer observation revision. */
export function assignBodyPatch(state: Record<BodyField, number[]>, revisions: Record<BodyField, number>, patch: BodyPatch, revision: number): void {
  for (const field of bodyFields) if (patch[field]) {
    state[field] = [...patch[field]!];
    revisions[field] = revision;
  }
}
