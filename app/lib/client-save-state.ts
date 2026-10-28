import type { DevicePayload } from "./client-api";

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

/** Recover an uncertain creation before applying edits to the same device draft. */
export class DeviceDraftWriter {
  private creation: { key: string; payload: DevicePayload } | null = null;
  private confirmedId: number | undefined;

  async save(requested: DevicePayload, write: (payload: DevicePayload) => Promise<{ device: DevicePayload & { id: number } }>) {
    const requireDevice = (result: { device: DevicePayload & { id: number } }) => {
      if (!Number.isSafeInteger(result?.device?.id) || result.device.id <= 0) {
        throw new Error("服务器未确认保存结果，草稿已保留，请核对云端藏品。");
      }
      return result.device;
    };
    const existingId = requested.id || this.confirmedId;
    if (existingId) return requireDevice(await write({ ...requested, id: existingId }));
    this.creation ||= { key: crypto.randomUUID(), payload: structuredClone(requested) };
    const created = requireDevice(await write({ ...this.creation.payload, idempotencyKey: this.creation.key }));
    this.confirmedId = created.id;
    // The draft may have changed after an earlier response was lost. Recover the
    // original request first; replaying its key with new fields would conflict.
    if (Object.keys(changedFields(requested, this.creation.payload)).length) {
      return requireDevice(await write({ ...requested, id: created.id }));
    }
    return created;
  }
}
