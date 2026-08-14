"use client";

import type { ClientTurbo } from "@/lib/workflows/turbo";

/**
 * Standard or Turbo for the workflow on screen.
 *
 * A segmented control rather than the on/off Toggle the params use, because
 * neither position is the absence of the other: both are a way to run this
 * graph, and naming them both is what says so. It sits above the form rather
 * than inside the Sampling group because it moves the step range that group
 * shows, and a control cannot sensibly live inside what it reconfigures.
 *
 * That is also why it stayed out here when the other run modes folded away into
 * ModelOptions: those change how the model is run without changing what any
 * control means, and this one does not.
 */
export function TurboSwitch({
  turbo,
  on,
  onChange,
}: {
  turbo: ClientTurbo;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-border-default bg-bg-subtle p-3">
      <div className="flex items-center gap-3">
        <span
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle"
          id="turbo-switch-label"
        >
          Speed
        </span>

        <div
          role="radiogroup"
          aria-labelledby="turbo-switch-label"
          aria-describedby="turbo-switch-help"
          className="ml-auto flex rounded-md border border-border-default bg-bg p-0.5"
        >
          {[
            { label: "Standard", value: false },
            { label: "Turbo", value: true },
          ].map((option) => {
            const selected = option.value === on;
            return (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(option.value)}
                className={`rounded px-3 py-1 text-[12px] font-medium transition-colors duration-150
                  ${
                    selected
                      ? "bg-accent-subtle text-fg"
                      : "text-fg-subtle hover:text-fg"
                  }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <p
        id="turbo-switch-help"
        className="mt-2 text-[12px] leading-relaxed text-fg-muted"
      >
        {turbo.help}
      </p>
    </div>
  );
}
