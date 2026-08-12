"use client";

import { Toggle } from "@/components/ui/inputs";
import type { ClientTurbo } from "@/lib/workflows/turbo";

/**
 * Standard or Turbo for the workflow on screen, and how turbo is applied.
 *
 * A segmented control rather than the on/off Toggle the params use, because
 * neither position is the absence of the other: both are a way to run this
 * graph, and naming them both is what says so. It sits above the form rather
 * than inside the Sampling group because it moves the step range that group
 * shows, and a control cannot sensibly live inside what it reconfigures.
 *
 * Low VRAM is a plain toggle underneath, and only in turbo: off, there is no
 * LoRA node in the graph for it to say anything about. It is here rather than
 * in the form because it is not a param — it does not travel with the workflow's
 * settings, and it is remembered once for the whole app.
 */
export function TurboSwitch({
  turbo,
  on,
  onChange,
  lowVram,
  onLowVramChange,
}: {
  turbo: ClientTurbo;
  on: boolean;
  onChange: (on: boolean) => void;
  lowVram: boolean;
  onLowVramChange: (lowVram: boolean) => void;
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

      {turbo.lowVram && on ? (
        <div className="mt-3 border-t border-border-default pt-3">
          <div className="flex items-center gap-3">
            <label
              htmlFor="turbo-low-vram"
              className="text-[12px] font-medium text-fg"
            >
              {turbo.lowVram.label}
            </label>
            <div className="ml-auto">
              <Toggle
                id="turbo-low-vram"
                checked={lowVram}
                onChange={onLowVramChange}
                describedBy="turbo-low-vram-help"
              />
            </div>
          </div>
          <p
            id="turbo-low-vram-help"
            className="mt-2 text-[12px] leading-relaxed text-fg-muted"
          >
            {turbo.lowVram.help}
          </p>
        </div>
      ) : null}
    </div>
  );
}
