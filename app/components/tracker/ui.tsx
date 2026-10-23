"use client";

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "neutral" | "primary" | "danger";
};

/** Native button semantics and event handlers, with one shared visual contract. */
export function ActionButton({ variant = "neutral", className = "", type = "button", ...props }: ActionButtonProps) {
  return <button {...props} type={type} className={`yuehua-button ${variant === "neutral" ? "" : `${variant}-button`} ${className}`} data-variant={variant} />;
}

export function DialogHeading({ eyebrow, title, id, onClose, disabled = false, closeLabel = "关闭", className = "modal-title" }: {
  eyebrow?: ReactNode; title: ReactNode; id?: string; onClose: () => void; disabled?: boolean; closeLabel?: string; className?: string;
}) {
  return <div className={`${className} yuehua-dialog-heading`}>
    <div>{eyebrow && <p>{eyebrow}</p>}<h2 id={id}>{title}</h2></div>
    <ActionButton className="yuehua-close" onClick={onClose} disabled={disabled} aria-label={closeLabel} title={closeLabel}>×</ActionButton>
  </div>;
}

export function DialogActions({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`submit-row yuehua-dialog-actions ${className}`} />;
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

/** Selection buttons keep native keyboard access and expose their pressed state. */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className = "", disabled = false }: {
  value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; label: string; className?: string; disabled?: boolean;
}) {
  return <div className={`yuehua-segments ${className}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" className={option.value === value ? "active" : ""}
      aria-pressed={option.value === value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
