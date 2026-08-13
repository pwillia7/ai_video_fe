"use client";

import { Toggle } from "@/components/ui/inputs";
import type { ClientPatch } from "@/lib/workflows/patches";

/**
 * The single-node switches a workflow offers — SageAttention, Spectrum — one
 * row each.
 *
 * Plain on/offs rather than the segmented control Turbo uses, and the difference
 * is deliberate: Standard and Turbo are two ways to sample the graph, and naming
 * them both is what says neither is the absence of the other. A patch genuinely
 * is a thing added to a run, so off is its absence and a switch is the honest
 * shape.
 *
 * Grouped in one box rather than one box each, so a third does not push the form
 * further down the panel than the settings it is meant to sit above. They are
 * out of the form because they are not params: they put a node in the graph
 * rather than a value in one, and they do not travel with the workflow's
 * settings.
 */
export function PatchSwitches({
  patches,
  on,
  onChange,
}: {
  patches: ClientPatch[];
  /** Ids currently switched on. */
  on: string[];
  onChange: (id: string, on: boolean) => void;
}) {
  if (patches.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border border-border-default bg-bg-subtle">
      {patches.map((patch) => (
        <div
          key={patch.id}
          className="border-b border-border-default p-3 last:border-0"
        >
          <div className="flex items-center gap-3">
            <label
              htmlFor={`patch-${patch.id}`}
              className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle"
            >
              {patch.label}
            </label>
            <div className="ml-auto">
              <Toggle
                id={`patch-${patch.id}`}
                checked={on.includes(patch.id)}
                onChange={(next) => onChange(patch.id, next)}
                describedBy={`patch-${patch.id}-help`}
              />
            </div>
          </div>

          <p
            id={`patch-${patch.id}-help`}
            className="mt-2 text-[12px] leading-relaxed text-fg-muted"
          >
            {patch.help}
          </p>
        </div>
      ))}
    </div>
  );
}
