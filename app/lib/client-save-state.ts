/** Build a patch without resending untouched fields from an old browser view. */
export function changedFields<T extends object>(next: T, previous: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(previous[key])) patch[key] = next[key];
  }
  return patch;
}

/** Retain failed edits when a later edit of the same item is queued. */
export function mergePendingChanges<T extends object>(patches: readonly T[]): T {
  const merged = {} as T & { metadata?: object };
  for (const patch of patches) {
    const fields = patch as T & { metadata?: object };
    const metadata = fields.metadata ? { ...merged.metadata, ...fields.metadata } : merged.metadata;
    Object.assign(merged, patch);
    if (metadata) merged.metadata = metadata;
  }
  return merged;
}

/** Serialize preference writes; a failed read must never initialize this writer. */
export class PreferenceWriter<T extends object> {
  private baseline: T | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  get ready() { return this.baseline !== null; }

  initialize(snapshot: T) { this.baseline = structuredClone(snapshot); }

  save(snapshot: T, write: (patch: Partial<T>) => Promise<unknown>): Promise<boolean> {
    if (!this.baseline) return Promise.resolve(false);
    const captured = structuredClone(snapshot);
    const task = this.queue.catch(() => undefined).then(async () => {
      if (!this.baseline) return false;
      const patch = changedFields(captured, this.baseline);
      if (!Object.keys(patch).length) return false;
      await write(patch);
      this.baseline = captured;
      return true;
    });
    this.queue = task;
    return task;
  }
}
