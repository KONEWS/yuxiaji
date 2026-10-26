"use client";

import { useRef, useState } from "react";
import { collectionPage } from "../../lib/collection-page";

/** Bound mounted cards without changing the full collection used for search/selection. */
export function useCollectionPage<T extends { id: number }>(items: T[]) {
  const [position, setPosition] = useState({ signature: "", page: 0 });
  const anchor = useRef<HTMLDivElement>(null);
  // Keep the page across edits that preserve order; reset when filters/order change.
  const signature = items.map((item) => item.id).join(",");
  if (position.signature !== signature) setPosition({ signature, page: 0 });
  const range = collectionPage(items.length, position.signature === signature ? position.page : 0);
  const go = (page: number) => {
    setPosition({ signature, page });
    anchor.current?.scrollIntoView({ block: "start", behavior: "instant" });
    anchor.current?.focus({ preventScroll: true });
  };
  return { items: items.slice(range.start, range.end), anchor, range, total: items.length, go };
}

export function CollectionPager({ range, total, go }: { range: ReturnType<typeof collectionPage>; total: number; go: (page: number) => void }) {
  if (range.pages <= 1) return null;
  return <nav className="collection-pagination" aria-label="收藏分页">
    <button className="quiet-button" disabled={range.page === 0} onClick={() => go(range.page - 1)}>上一页</button>
    <span aria-live="polite">{range.start + 1}–{range.end} / {total} 条 · 第 {range.page + 1}/{range.pages} 页</span>
    <button className="quiet-button" disabled={range.page === range.pages - 1} onClick={() => go(range.page + 1)}>下一页</button>
  </nav>;
}
