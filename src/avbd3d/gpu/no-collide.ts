// The solver's no-collide list (IGNORE_PAIRS_WGSL): (hi, lo, joint slot) entries sorted by (hi,
// lo), kept on the CPU and uploaded when it changed. Pure bookkeeping, so it is tested without a GPU.

/** The slot word of an IgnoreCollision entry: no joint, the pair never collides. */
export const IGNORE_SLOT = 0xffffffff;

export type NoCollideEntry = [hi: number, lo: number, slot: number];

const by = (x: NoCollideEntry, y: NoCollideEntry) => x[0] - y[0] || x[1] - y[1];

/**
 * Entries come in with `add` and go with `release` (a joint slot taken out), and `flush` gives
 * the sorted list. A slot released and reused before the next flush keeps only the entry added
 * after its last release: the shader checks the slot's live joint, so an entry left from the
 * slot's old pair would keep that pair apart for as long as the new joint holds.
 */
export class NoCollideTable {
  private entries: NoCollideEntry[] = [];
  private pending: NoCollideEntry[] = [];
  private released = new Set<number>();
  /** The list changed since the last flush. */
  dirty = true;

  /** Bodies a and b do not collide while joint slot `slot` (or IGNORE_SLOT: always) holds. */
  add(a: number, b: number, slot: number): void {
    this.pending.push([Math.max(a, b), Math.min(a, b), slot]);
    this.dirty = true;
  }

  /** These joint slots no longer hold: their entries go, including any not yet flushed. */
  release(slots: Iterable<number>): void {
    const gone = new Set(slots);
    if (!gone.size) return;
    for (const slot of gone) this.released.add(slot);
    if (this.pending.length) this.pending = this.pending.filter((e) => !gone.has(e[2]));
    this.dirty = true;
  }

  /** The sorted list: released slots' entries gone, new ones (sorted) merged into the kept list. */
  flush(): readonly NoCollideEntry[] {
    if (!this.dirty) return this.entries;
    const kept = this.released.size ? this.entries.filter((e) => !this.released.has(e[2])) : this.entries;
    this.released.clear();
    const fresh = this.pending.sort(by);
    this.pending = [];
    const merged: NoCollideEntry[] = [];
    for (let i = 0, k = 0; i < kept.length || k < fresh.length; ) {
      if (k >= fresh.length || (i < kept.length && by(kept[i], fresh[k]) <= 0)) merged.push(kept[i++]);
      else merged.push(fresh[k++]);
    }
    this.entries = merged;
    this.dirty = false;
    return merged;
  }
}
