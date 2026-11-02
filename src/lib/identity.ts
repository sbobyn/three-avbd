// CPU lifetime bookkeeping; the watch word reserves bit 31 for reporting.
export const MAX_BODY_ID = 0x7fffffff;

export class BodyIds {
  private next = 1;
  get remaining(): number { return MAX_BODY_ID - this.next + 1; }
  allocate(): number {
    if (this.next > MAX_BODY_ID) throw new Error('Body lifetime IDs exhausted');
    return this.next++;
  }
}

export function assertOwner(world: unknown, body: { world: unknown }): void {
  if (body.world !== world) throw new Error('Body belongs to another world');
}

export function sameReadStep(submitted: number, reading: number): boolean {
  return submitted === reading;
}

/** Keep removed identities through the next step's end pass, not merely the next read.
 * Eviction forgets an identity; loss is counted per unverifiable event, not per eviction. */
export class RetiredBodies<T extends { id: number; index: number }> {
  private readonly slots = new Map<number, { body: T; step: number }[]>();
  private readonly capacity: number;
  constructor(capacity = 8) { this.capacity = capacity; }
  retire(body: T, step: number): void {
    const list = this.slots.get(body.index) ?? [];
    list.push({ body, step });
    if (list.length > this.capacity) list.shift();
    this.slots.set(body.index, list);
  }
  snapshot(live: readonly T[]): Map<number, T> {
    const result = new Map(live.map(body => [body.id, body]));
    for (const list of this.slots.values()) for (const { body } of list) result.set(body.id, body);
    return result;
  }
  drain(step: number): void {
    for (const [index, list] of this.slots) {
      const retained = list.filter(entry => entry.step >= step);
      if (retained.length) this.slots.set(index, retained);
      else this.slots.delete(index);
    }
  }
}

/** End before begin within a step; stable otherwise. Resolve before invoking listeners. */
export function orderedEvents<T extends { step: number; kind: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.step - b.step || b.kind - a.kind);
}
