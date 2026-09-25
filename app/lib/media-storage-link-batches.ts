export const MEDIA_STORAGE_LINK_QUERY_BATCH_SIZE = 90;

export type StorageLinkOrderRow = {
  mediaId: number;
  isPrimary: boolean | number;
  id: number;
};

export function normalizeStorageMediaIds(mediaIds: number[]) {
  return Array.from(new Set(mediaIds.filter((id) => Number.isInteger(id) && id > 0)));
}

/** Execute storage-link reads in bounded, sequential batches. */
export async function queryStorageLinkBatches<Row>(
  mediaIds: number[],
  queryBatch: (batchIds: number[]) => Promise<Row[]>,
) {
  const ids = normalizeStorageMediaIds(mediaIds);
  const rows: Row[] = [];
  for (let offset = 0; offset < ids.length; offset += MEDIA_STORAGE_LINK_QUERY_BATCH_SIZE) {
    rows.push(...await queryBatch(ids.slice(offset, offset + MEDIA_STORAGE_LINK_QUERY_BATCH_SIZE)));
  }
  return rows;
}

export function groupStorageLinkRows<Row extends StorageLinkOrderRow, Presented>(
  rows: Row[],
  present: (row: Row) => Presented,
) {
  const grouped = new Map<number, Presented[]>();
  const sorted = [...rows].sort((left, right) => (
    left.mediaId - right.mediaId
    || Number(right.isPrimary) - Number(left.isPrimary)
    || left.id - right.id
  ));
  for (const row of sorted) {
    grouped.set(row.mediaId, [...(grouped.get(row.mediaId) || []), present(row)]);
  }
  return grouped;
}
