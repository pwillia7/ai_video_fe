import type { ReactNode } from "react";

/**
 * Label + control + help/error, with the label wired to the control by id so
 * clicking it focuses the input and screen readers announce the pairing.
 */
export function Field({
  id,
  label,
  help,
  error,
  trailing,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  /** Sits opposite the label, typically the live value of a slider. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="text-[13px] font-medium tracking-[-0.01em] text-fg"
        >
          {label}
        </label>
        {trailing}
      </div>

      {/*
        The control wires its own aria-describedby to the ids below — each input
        component takes it as a prop. This wrapper only renders the messages.
      */}
      {children}

      {error ? (
        <p id={`${id}-error`} className="text-[12px] leading-snug text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-[12px] leading-snug text-fg-subtle">
          {help}
        </p>
      ) : null}
    </div>
  );
}
