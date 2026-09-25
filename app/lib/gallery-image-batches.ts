export const GALLERY_IMAGE_QUERY_BATCH_SIZE = 90;

export function normalizeGallerySubjectIds(subjectIds: number[]) {
  return Array.from(new Set(subjectIds.filter((id) => Number.isInteger(id) && id > 0)));
}

export type GalleryImageOrderRow = {
  subjectId: number;
  sortOrder: number;
  id: number;
};

/** Execute gallery-image reads/deletes in bounded, sequential batches. */
export async function queryGalleryImageBatches<Row>(
  subjectIds: number[],
  queryBatch: (batchIds: number[]) => Promise<Row[]>,
) {
  const ids = normalizeGallerySubjectIds(subjectIds);
  const rows: Row[] = [];
  for (let offset = 0; offset < ids.length; offset += GALLERY_IMAGE_QUERY_BATCH_SIZE) {
    rows.push(...await queryBatch(ids.slice(offset, offset + GALLERY_IMAGE_QUERY_BATCH_SIZE)));
  }
  return rows;
}

export function groupGalleryImageRows<Row extends GalleryImageOrderRow>(rows: Row[]) {
  const grouped = new Map<number, Row[]>();
  const sorted = [...rows].sort((left, right) => (
    left.subjectId - right.subjectId
    || left.sortOrder - right.sortOrder
    || left.id - right.id
  ));
  for (const row of sorted) grouped.set(row.subjectId, [...(grouped.get(row.subjectId) || []), row]);
  return grouped;
}
