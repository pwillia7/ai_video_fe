"use client";

import { useState } from "react";
import { Disclosure } from "@/components/param-form";
import { Toggle } from "@/components/ui/inputs";
import { patchSuppressed, type ClientPatch } from "@/lib/workflows/patches";
import type { ClientTurbo } from "@/lib/workflows/turbo";
import type { ParamValue } from "@/lib/workflows/types";

/**
 * Everything that changes how the model is run, behind one heading.
 *
 * These are not params — each puts a node in the graph rather than a value in
 * one, and none of them travels with the workflow's settings — but they are
 * also not things anyone changes per shot. They answer questions about the
 * machine and the install: whether this card holds the LoRA the fast way,
 * whether these kernels are worth using here. Set once, then in the way.
 *
 * So they fold up. Closed is the default, with what is on summarised on the
 * heading, because all three ship on and a collapsed section that gave no hint
 * of its contents would hide that from the person it matters to.
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
      return {
        key: patch.id,
        label: patch.label,
        help: refused ? patch.suppressedAt!.note : patch.help,
        checked: !refused && on.includes(patch.id),
        refused,
        onChange: (next: boolean) => onPatchChange(patch.id, next),
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
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
