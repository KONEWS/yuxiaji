"use client";

import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keyboard/focus behavior shared by editors, with a single guarded close path. */
export function useDialogBehavior<T extends HTMLElement = HTMLElement>({ close, dirty = false, busy = false }: { close: () => void; dirty?: boolean; busy?: boolean }) {
  const dialogRef = useRef<T>(null);
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm("有尚未保存的修改，确定关闭编辑吗？")) return;
    close();
  }, [busy, close, dirty]);
  const latestClose = useRef(requestClose);
  useEffect(() => { latestClose.current = requestClose; }, [requestClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isTopDialog = () => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      return dialogs[dialogs.length - 1] === dialog;
    };
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element =>
      element.getClientRects().length > 0 && !element.closest('[inert], [hidden], fieldset:disabled'),
    );
    // Focus the labelled container without opening a phone's software keyboard.
    dialog.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        latestClose.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!first) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTopDialog() && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return { dialogRef, requestClose };
}
