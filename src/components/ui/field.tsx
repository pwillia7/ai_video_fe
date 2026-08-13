import type { ReactNode } from "react";

/**
 * Label + control + help/error, with the label wired to the control by id so
 * clicking it focuses the input and screen readers announce the pairing.
 */
export function Field({
  id,
  label,
  help,
  note,
  error,
  trailing,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  /**
   * A consequence of the current value, shown under the help rather than in
   * place of it — the help says what the control is for at every setting, and
   * this says what this setting additionally does. Marked out by colour because
   * its appearing is the information; a line that read like the help would just
   * look as though the help had grown.
   */
  note?: string;
  error?: string;
  /** Sits opposite the label, typically the live value of a slider. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
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

      {/*
        Outside the error/help chain: a note is about the value rather than
        about the control, so it stands whether or not the field is also
        explaining or complaining.
      */}
      {note ? (
        <p
          id={`${id}-note`}
          className="flex items-baseline gap-1.5 text-[12px] leading-snug text-fg-muted"
        >
          <span
            aria-hidden="true"
            className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-accent"
          />
          {note}
        </p>
      ) : null}
    </div>
  );
}
