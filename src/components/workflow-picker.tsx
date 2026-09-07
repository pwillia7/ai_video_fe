"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkflowSummary } from "@/lib/workflows/types";

/**
 * The predetermined workflow list. Radio semantics rather than buttons so
 * arrow keys move between options the way a grouped choice should.
 */
export function WorkflowPicker({
  workflows,
  turbo,
  patches,
  selectedId,
  onSelect,
  disabled,
}: {
  workflows: WorkflowSummary[];
  /**
   * Which workflows are in turbo. The switch lives in the settings panel, but
   * the mode changes what a run costs, so the estimate on the card has to
   * follow it — otherwise picking a workflow tells you the wrong number about
   * the mode you left it in.
   */
  turbo: Record<string, boolean>;
  /**
   * The same for the single-node switches, by id — for the estimate only. They
   * carry no badge: three of them alongside Turbo overran the card and pushed
   * the name out of it, and unlike Turbo none of them changes what any control
   * on the next screen means, so the switch itself is the only place they need
   * to be visible.
   */
  patches: Record<string, string[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  /**
   * Collapsed once a workflow is chosen, which is immediately and for the rest
   * of the session.
   *
   * The list is six cards carrying a description each, and it sits above the
   * form in the column the form is in — so left open it is most of a screen of
   * navigation scrolled past on the way to the controls, every visit, to reach
   * the one thing on it that has changed: nothing. Open is still the state for
   * a first look, and for whenever the choice is actually being made.
   */
  const [open, setOpen] = useState(!selectedId);

  /**
   * Reopening when the choice goes away, and closing when it arrives — which is
   * what the hand-off buttons do: pressing Remix on a finished clip picks a
   * workflow from the other side of the page, and the list has no reason to be
   * standing open afterwards.
   */
  const previous = useRef(selectedId);
  useEffect(() => {
    if (previous.current !== selectedId) {
      previous.current = selectedId;
      if (selectedId) setOpen(false);
    }
  }, [selectedId]);

  const current = workflows.find((workflow) => workflow.id === selectedId);

  if (!open && current) {
    return (
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="group flex w-full items-center gap-2 rounded-lg border border-border-default
            bg-bg-subtle p-3 text-left transition-colors duration-150
            hover:border-border-strong hover:bg-surface-hover
            disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
            {current.name}
          </span>
          {Boolean(turbo[current.id]) && Boolean(current.turbo) ? (
            <Badge>Turbo</Badge>
          ) : null}
          <span className="ml-auto shrink-0 text-[12px] text-fg-subtle">
            Change
          </span>
          <Chevron />
        </button>
        <p className="mt-1.5 px-3 text-[12px] leading-relaxed text-fg-muted">
          {current.description}
        </p>
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="Workflow" className="flex flex-col gap-2">
      {workflows.map((workflow) => {
        const selected = workflow.id === selectedId;
        const isTurbo = Boolean(turbo[workflow.id]) && Boolean(workflow.turbo);
        const on = patches[workflow.id] ?? [];
        const estimate =
          workflow.patches
            .filter((patch) => on.includes(patch.id))
            .map((patch) => patch.estimatedSeconds)
            .findLast((seconds) => seconds !== undefined) ??
          (isTurbo ? workflow.turbo?.estimatedSeconds : undefined) ??
          workflow.estimatedSeconds;
        return (
          <button
            key={workflow.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(workflow.id)}
            className={`group w-full rounded-lg border p-3 text-left transition-all duration-150
              disabled:opacity-50 disabled:pointer-events-none
              ${
                selected
                  ? "border-accent bg-accent-subtle/40"
                  : "border-border-default bg-bg-subtle hover:border-border-strong hover:bg-surface-hover"
              }`}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`grid size-3.5 shrink-0 place-items-center rounded-full border transition-colors
                  ${selected ? "border-accent" : "border-border-strong"}`}
              >
                {selected ? (
                  <span className="size-1.5 rounded-full bg-accent" />
                ) : null}
              </span>
              {/* min-w-0 and truncate so a long name gives way rather than
                  widening the row past the card, as the badges used to. */}
              <span className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-fg">
                {workflow.name}
              </span>
              {isTurbo ? <Badge>Turbo</Badge> : null}
              {estimate ? (
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  ~{formatEstimate(estimate)}
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 pl-[22px] text-[12px] leading-relaxed text-fg-muted">
              {workflow.description}
            </p>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A mode the card is currently in, named on the card. Only Turbo earns one: it
 * moves the step range the next screen shows, so the card would otherwise state
 * an estimate for a mode nothing on it mentions.
 */
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-medium
        uppercase tracking-[0.06em] text-fg-muted"
    >
      {children}
    </span>
  );
}

/** Points down, because opening the list grows the column downwards. */
function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5 shrink-0 text-fg-subtle"
      fill="none"
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatEstimate(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
