"use client";

import { useState } from "react";
import { Disclosure } from "@/components/param-form";
import { Slider, Toggle } from "@/components/ui/inputs";
import { patchSuppressed, type ClientPatch } from "@/lib/workflows/patches";
import type { ClientTurbo } from "@/lib/workflows/turbo";
import type { ParamValue } from "@/lib/workflows/types";

/**
 * Everything that changes how the model is run, behind one heading.
 *
 * These are not params — each puts a node in the graph rather than a value in
 * one, and none of them travels with the workflow's settings. Most answer
 * questions about the machine and the install rather than about the shot:
 * whether this card holds the LoRA the fast way, whether these kernels are
 * worth using here. Set once, then in the way.
 *
 * So they fold up. Closed is the default, with what is on summarised on the
 * heading, because the ones about the machine ship on and a collapsed section
 * that gave no hint of its contents would hide that from the person it matters
 * to.
 *
 * A switch may carry a strength, which does belong to the shot — the VHS LoRA's
 * does. It sits under its own switch and appears only while that switch is on,
 * because the input it writes belongs to a node that is in the graph only then.
 * Under the switch rather than out in the sidebar so the pair cannot be read
 * apart: a strength with nothing applying it is a number that does nothing.
 *
 * Turbo is not in here. It moves the step range the form below shows, so it has
 * to stay where the thing it reconfigures can be seen — see TurboSwitch.
 */
export function ModelOptions({
  patches,
  on,
  values,
  onPatchChange,
  turbo,
  turboOn,
  lowVram,
  onLowVramChange,
  strengths,
  onStrengthChange,
  alternateBase,
  onAlternateBaseChange,
}: {
  patches: ClientPatch[];
  /** Ids of the patches currently switched on. */
  on: string[];
  /**
   * The form's values as they will actually run — pins applied, see
   * `pinnedValues`. Read only to answer whether a step count is refusing one of
   * these switches, which is a fact about the graph rather than about the form.
   */
  values: Record<string, ParamValue>;
  onPatchChange: (id: string, on: boolean) => void;
  /** Absent where the workflow has no turbo mode, which hides Low VRAM. */
  turbo?: ClientTurbo;
  turboOn: boolean;
  lowVram: boolean;
  onLowVramChange: (lowVram: boolean) => void;
  /** Current value of each switch's strength control, by patch id. */
  strengths: Record<string, number>;
  onStrengthChange: (id: string, value: number) => void;
  /** Which switches are on their alternate base, by patch id. */
  alternateBase: Record<string, boolean>;
  onAlternateBaseChange: (id: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  // Low VRAM is only meaningful in turbo: off, there is no LoRA node in the
  // graph for it to say anything about.
  const showLowVram = Boolean(turbo?.lowVram) && turboOn;

  const rows = [
    ...patches.map((patch) => {
      // The run will not have this node whatever the switch says, so the switch
      // says so too: shown off, taking no input, with the rule underneath in
      // place of the help. Its stored value is untouched and comes straight
      // back when the control that refuses it moves.
      const refused = patchSuppressed(patch, values);
      const checked = !refused && on.includes(patch.id);
      return {
        key: patch.id,
        label: patch.label,
        help: refused ? patch.suppressedAt!.note : patch.help,
        checked,
        refused,
        onChange: (next: boolean) => onPatchChange(patch.id, next),
        // Only while the switch is on: off, the graph loads whatever it always
        // did, so a base choice would be selecting between two checkpoints
        // neither of which the run uses — the same rule Low VRAM follows
        // against turbo, and the strength below follows against this.
        baseAlternate:
          checked && patch.baseAlternate
            ? {
                spec: patch.baseAlternate,
                checked: alternateBase[patch.id] === true,
                onChange: (next: boolean) =>
                  onAlternateBaseChange(patch.id, next),
              }
            : undefined,
        // Only while the switch is on: off, the node this writes to is not in
        // the graph, so a slider would be setting an input on nothing.
        strength:
          checked && patch.strength
            ? {
                spec: patch.strength,
                value: strengths[patch.id] ?? patch.strength.default,
                onChange: (next: number) => onStrengthChange(patch.id, next),
              }
            : undefined,
      };
    }),
    ...(showLowVram && turbo?.lowVram
      ? [
          {
            key: "low-vram",
            label: turbo.lowVram.label,
            help: turbo.lowVram.help,
            checked: lowVram,
            refused: false,
            onChange: onLowVramChange,
            baseAlternate: undefined,
            strength: undefined,
          },
        ]
      : []),
  ];

  if (rows.length === 0) return null;

  const enabled = rows.filter((row) => row.checked).map((row) => row.label);

  return (
    <div className="mb-6 rounded-lg border border-border-default bg-bg-subtle">
      <div className="flex items-center gap-3 p-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle">
          Model
        </span>
        {/* What is on, so the section can stay shut without hiding its state.
            min-w-0 and truncate so a long list gives way rather than widening
            the panel. */}
        <span className="min-w-0 flex-1 truncate text-right text-[12px] text-fg-muted">
          {enabled.length > 0 ? enabled.join(", ") : "None"}
        </span>
        <Disclosure open={open} onToggle={() => setOpen((was) => !was)}>
          <span className="sr-only">Model options</span>
        </Disclosure>
      </div>

      {open ? (
        <div className="border-t border-border-default">
          {rows.map((row) => (
            <div
              key={row.key}
              className="border-b border-border-default p-3 last:border-0"
            >
              <div className="flex items-center gap-3">
                <label
                  htmlFor={`model-${row.key}`}
                  className={`text-[12px] font-medium ${
                    row.refused ? "text-fg-subtle" : "text-fg"
                  }`}
                >
                  {row.label}
                </label>
                <div className="ml-auto">
                  <Toggle
                    id={`model-${row.key}`}
                    checked={row.checked}
                    onChange={row.onChange}
                    disabled={row.refused}
                    describedBy={`model-${row.key}-help`}
                  />
                </div>
              </div>
              <p
                id={`model-${row.key}-help`}
                className="mt-2 text-[12px] leading-relaxed text-fg-muted"
              >
                {row.help}
              </p>

              {/* Before the strength, because it decides which weights the
                  strength is applied to. */}
              {row.baseAlternate ? (
                <div className="mt-3 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={`model-${row.key}-base`}
                      className="text-[12px] text-fg-muted"
                    >
                      {row.baseAlternate.spec.label}
                    </label>
                    <p
                      id={`model-${row.key}-base-help`}
                      className="mt-1 text-[12px] leading-relaxed text-fg-muted"
                    >
                      {row.baseAlternate.spec.help}
                    </p>
                  </div>
                  <Toggle
                    id={`model-${row.key}-base`}
                    checked={row.baseAlternate.checked}
                    onChange={row.baseAlternate.onChange}
                    describedBy={`model-${row.key}-base-help`}
                  />
                </div>
              ) : null}

              {row.strength ? (
                <div className="mt-3">
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor={`model-${row.key}-strength`}
                      className="text-[12px] text-fg-muted"
                    >
                      {row.strength.spec.label}
                    </label>
                    <span className="ml-auto tabular-nums text-[12px] text-fg">
                      {row.strength.value.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Slider
                      id={`model-${row.key}-strength`}
                      value={row.strength.value}
                      onChange={row.strength.onChange}
                      min={row.strength.spec.min}
                      max={row.strength.spec.max}
                      step={row.strength.spec.step}
                      describedBy={`model-${row.key}-strength-help`}
                    />
                  </div>
                  <p
                    id={`model-${row.key}-strength-help`}
                    className="mt-2 text-[12px] leading-relaxed text-fg-muted"
                  >
                    {row.strength.spec.help}
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
