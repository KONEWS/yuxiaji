"use client";

import { useEffect } from "react";

// Paint a moving highlight with CSS variables; React keeps ownership of all
// buttons and data. No inserted children, remounts, or extra API requests.
export function YuehuaMotion() {
  useEffect(() => {
    const root = document.body;
    const selector = ".desktop-nav, .mobile-view-tabs, .status-tabs, .media-tabs, .view-toggle, .week-strip, .device-category-tabs, .collection-chips, .calendar-tabs, .calendar-source-tabs, .subcategory-tabs, .font-options, .title-options, .media-type-picker, .bangumi-sync-direction";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const watched = new Set<HTMLElement>();
    const selected = new WeakMap<HTMLElement, HTMLElement | null>();
    const animations = new Map<HTMLElement, Animation>();
    let frame = 0;
    let readyFrame = 0;
    let stopped = false;

    function animateContent(group: HTMLElement) {
      if (reduced.matches) return;
      const dialog = group.closest<HTMLElement>('[role="dialog"]');
      const target = group.matches(".week-strip")
        ? root.querySelector<HTMLElement>(".schedule-list")
        : dialog
          ? dialog.querySelector<HTMLElement>(".calendar-body, .subcategory-sort-list, .tag-manager-list, .tag-manager-cloud, .form-grid")
          : root.querySelector<HTMLElement>(".anime-grid, .device-grid");
      if (!target) return;
      animations.get(target)?.cancel();
      const animation = target.animate([
        { opacity: .55, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      animations.set(target, animation);
      animation.onfinish = () => {
        if (animations.get(target) === animation) animations.delete(target);
      };
    }

    function update() {
      frame = 0;
      if (stopped) return;
      const groups = Array.from(root!.querySelectorAll<HTMLElement>(selector));
      for (const group of watched) {
        if (!root!.contains(group)) {
          resize.unobserve(group);
          watched.delete(group);
        }
      }
      // Read layout for all groups before writing styles.
      const measurements = groups.map(group => {
        if (!watched.has(group)) {
          watched.add(group);
          resize.observe(group);
        }
        const active = group.querySelector<HTMLElement>(":scope > button.active");
        const bounds = group.getBoundingClientRect();
        const box = active?.getBoundingClientRect();
        return { group, active, hadHighlight: group.style.getPropertyValue("--slide-opacity") === "1",
          visible: Boolean(box?.width && bounds.width),
          x: box ? box.left - bounds.left - group.clientLeft + group.scrollLeft : 0,
          y: box ? box.top - bounds.top - group.clientTop + group.scrollTop : 0,
          width: box?.width ?? 0, height: box?.height ?? 0 };
      });
      for (const { group, active, hadHighlight, visible, x, y, width, height } of measurements) {
        const changed = selected.has(group) && selected.get(group) !== active;
        selected.set(group, active);
        // Clearing a filter fades the highlight where it was. Collapsing its
        // rectangle to zero would animate it toward the container's origin.
        if (visible) {
          // A new selection after clearing starts at its own button, not at
          // the old invisible rectangle (also covers responsive hidden groups).
          if (!hadHighlight) group.classList.remove("yuehua-slide-ready");
          group.style.setProperty("--slide-x", x + "px");
          group.style.setProperty("--slide-y", y + "px");
          group.style.setProperty("--slide-width", width + "px");
          group.style.setProperty("--slide-height", height + "px");
        }
        group.style.setProperty("--slide-opacity", visible ? "1" : "0");
        group.classList.add("yuehua-sliding");
        if (changed && visible) animateContent(group);
      }
      cancelAnimationFrame(readyFrame);
      readyFrame = requestAnimationFrame(() => {
        if (!stopped) measurements.forEach(({ group, visible }) => {
          if (visible) group.classList.add("yuehua-slide-ready");
        });
      });
    }
    function schedule() {
      if (!frame && !stopped) frame = requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.type === "childList" ||
        record.target instanceof HTMLButtonElement)) schedule();
    });
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(readyFrame);
      mutations.disconnect();
      resize.disconnect();
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      animations.forEach(animation => animation.cancel());
      watched.forEach(group => {
        group.classList.remove("yuehua-sliding", "yuehua-slide-ready");
        ["x", "y", "width", "height", "opacity"].forEach(name => group.style.removeProperty("--slide-" + name));
      });
    };
  }, []);
  return null;
}
