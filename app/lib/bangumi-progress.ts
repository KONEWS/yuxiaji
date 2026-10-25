/** Books track volumes; manga and anime track chapters/episodes. Music keeps
 * the existing import convention and does not gain progress writeback. */
export function bangumiProgressField(mediaType: string): "vol_status" | "ep_status" {
  return mediaType === "light_novel" || mediaType === "music" ? "vol_status" : "ep_status";
}

export function readBangumiProgress(mediaType: string, collection: { vol_status?: unknown; ep_status?: unknown }) {
  const progress = collection[bangumiProgressField(mediaType)];
  return typeof progress === "number" && Number.isInteger(progress) && progress >= 0 ? progress : 0;
}
