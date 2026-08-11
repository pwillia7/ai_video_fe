"use client";

import type { WorkflowSummary } from "@/lib/workflows/types";

/**
 * The predetermined workflow list. Radio semantics rather than buttons so
 * arrow keys move between options the way a grouped choice should.
 */
export function WorkflowPicker({
  workflows,
  turbo,
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
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Workflow" className="flex flex-col gap-2">
      {workflows.map((workflow) => {
        const selected = workflow.id === selectedId;
        const isTurbo = Boolean(turbo[workflow.id]) && Boolean(workflow.turbo);
        const estimate = isTurbo
          ? (workflow.turbo?.estimatedSeconds ?? workflow.estimatedSeconds)
          : workflow.estimatedSeconds;
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
              <span className="text-[13px] font-medium tracking-[-0.01em] text-fg">
                {workflow.name}
              </span>
              {isTurbo ? (
                <span
                  className="rounded bg-accent-subtle px-1.5 py-0.5 text-[10px] font-medium
                    uppercase tracking-[0.06em] text-fg-muted"
                >
                  Turbo
                </span>
              ) : null}
              {estimate ? (
                <span className="ml-auto font-mono text-[11px] tabular-nums text-fg-subtle">
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

function formatEstimate(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
