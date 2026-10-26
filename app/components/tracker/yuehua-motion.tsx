"use client";

import { useEffect } from "react";

// Discover new groups once, then measure only groups whose selection/size changed.
// Ordinary document scrolling does not change a highlight's local coordinates.
export function YuehuaMotion() {
  useEffect(() => {
    const root = document.body;
    const selector = ".yuehua-segments, .desktop-nav, .mobile-view-tabs, .status-tabs, .media-tabs, .view-toggle, .week-strip, .device-category-tabs, .collection-chips, .calendar-tabs, .calendar-source-tabs, .subcategory-tabs, .font-options, .title-options, .media-type-picker, .bangumi-sync-direction";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const groups = new Map<HTMLElement, { observer: MutationObserver; buttons: Set<HTMLElement> }>();
    const owners = new WeakMap<Element, HTMLElement>();
    const dirty = new Set<HTMLElement>();
    const selected = new WeakMap<HTMLElement, HTMLElement | null>();
    const animations = new Map<HTMLElement, Animation>();
    let frame = 0;
    let readyFrame = 0;
    let stopped = false;

    function mark(group: HTMLElement) {
      dirty.add(group);
      if (!frame && !stopped) frame = requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(entries => {
      for (const entry of entries) {
        const group = owners.get(entry.target);
        if (group) mark(group);
      }
    });
    function syncButtons(group: HTMLElement) {
      const state = groups.get(group);
      if (!state) return;
      for (const button of state.buttons) if (button.parentElement !== group) {
        resize.unobserve(button);
        state.buttons.delete(button);
      }
      for (const child of group.children) if (child instanceof HTMLButtonElement && !state.buttons.has(child)) {
        state.buttons.add(child);
        owners.set(child, group);
        resize.observe(child);
      }
    }
    function discover(node: Node) {
      if (!(node instanceof HTMLElement)) return;
      const found = [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll<HTMLElement>(selector)];
      for (const group of found) {
        if (groups.has(group)) continue;
        const observer = new MutationObserver(records => {
          // Ignore the classes written onto the group by this controller.
          if (records.some(record => record.type !== "attributes" || record.target !== group)) {
            syncButtons(group);
            mark(group);
          }
        });
        observer.observe(group, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
        groups.set(group, { observer, buttons: new Set() });
        owners.set(group, group);
        resize.observe(group);
        syncButtons(group);
        mark(group);
      }
    }
    function animateContent(group: HTMLElement, animated: Set<HTMLElement>) {
      if (reduced.matches) return;
      const dialog = group.closest<HTMLElement>('[role="dialog"]');
      const target = group.matches(".week-strip") ? root.querySelector<HTMLElement>(".schedule-list")
        : dialog ? dialog.querySelector<HTMLElement>(".calendar-body, .subcategory-sort-list, .tag-manager-list, .tag-manager-cloud, .form-grid")
          : root.querySelector<HTMLElement>(".anime-grid, .device-grid");
      if (!target || animated.has(target)) return;
      animated.add(target);
      animations.get(target)?.cancel();
      const animation = target.animate([{ opacity: .55, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      animations.set(target, animation);
      animation.onfinish = () => { if (animations.get(target) === animation) animations.delete(target); };
    }
    function update() {
      frame = 0;
      if (stopped) return;
      const measurements = Array.from(dirty).filter(group => group.isConnected).map(group => {
        const active = group.querySelector<HTMLElement>(":scope > button.active");
        const bounds = group.getBoundingClientRect();
        const box = active?.getBoundingClientRect();
        return { group, active, hadHighlight: group.style.getPropertyValue("--slide-opacity") === "1",
          visible: Boolean(box?.width && bounds.width),
          x: box ? box.left - bounds.left - group.clientLeft + group.scrollLeft : 0,
          y: box ? box.top - bounds.top - group.clientTop + group.scrollTop : 0,
          width: box?.width ?? 0, height: box?.height ?? 0 };
      });
      dirty.clear();
      const animated = new Set<HTMLElement>();
      const set = (group: HTMLElement, name: string, value: string) => {
        if (group.style.getPropertyValue(name) !== value) group.style.setProperty(name, value);
      };
      for (const { group, active, hadHighlight, visible, x, y, width, height } of measurements) {
        const changed = selected.has(group) && selected.get(group) !== active;
        selected.set(group, active);
        if (visible) {
          if (!hadHighlight) group.classList.remove("yuehua-slide-ready");
          set(group, "--slide-x", x + "px"); set(group, "--slide-y", y + "px");
          set(group, "--slide-width", width + "px"); set(group, "--slide-height", height + "px");
        }
        set(group, "--slide-opacity", visible ? "1" : "0");
        group.classList.add("yuehua-sliding");
        if (changed && visible) animateContent(group, animated);
      }
      // Include every newly visible group even if another update precedes this frame.
      if (!readyFrame) readyFrame = requestAnimationFrame(() => {
        readyFrame = 0;
        if (!stopped) for (const group of groups.keys()) {
          if (group.style.getPropertyValue("--slide-opacity") === "1") group.classList.add("yuehua-slide-ready");
        }
      });
    }
    const mutations = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) discover(node);
      if (records.some(record => record.removedNodes.length)) for (const [group, state] of groups) {
        if (group.isConnected) continue;
        state.observer.disconnect(); resize.unobserve(group);
        state.buttons.forEach(button => resize.unobserve(button));
        groups.delete(group); dirty.delete(group);
      }
    });
    mutations.observe(root, { childList: true, subtree: true });
    const refresh = () => { for (const group of groups.keys()) mark(group); };
    window.addEventListener("resize", refresh, { passive: true });
    discover(root);
    void document.fonts?.ready.then(() => { if (!stopped) refresh(); });
    return () => {
      stopped = true;
      cancelAnimationFrame(frame); cancelAnimationFrame(readyFrame);
      mutations.disconnect(); resize.disconnect();
      window.removeEventListener("resize", refresh);
      animations.forEach(animation => animation.cancel());
      for (const [group, state] of groups) {
        state.observer.disconnect();
        group.classList.remove("yuehua-sliding", "yuehua-slide-ready");
        ["x", "y", "width", "height", "opacity"].forEach(name => group.style.removeProperty("--slide-" + name));
      }
    };
  }, []);
  return null;
}
