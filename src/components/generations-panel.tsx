"use client";

import { Dot } from "@/components/ui/panel";
import { formatDuration, formatWhen, isActive, type Job } from "@/lib/jobs";

const PHASE_LABEL: Record<Job["phase"], string> = {
  queued: "Queued",
  running: "Generating",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  unknown: "Lost",
};

const PHASE_TONE: Record<
  Job["phase"],
  "neutral" | "accent" | "success" | "warning" | "danger"
> = {
  queued: "neutral",
  running: "accent",
  done: "success",
  error: "danger",
  cancelled: "warning",
  unknown: "warning",
};

/**
 * Past and in-flight generations for this device.
 *
 * Only references are kept, so an entry stops playing if ComfyUI's output
 * directory is cleared. That is worth the trade — storing the video itself
 * would exhaust localStorage after a couple of clips.
 */
export function GenerationsPanel({
  jobs,
  selectedId,
  now,
  onSelect,
  onCancel,
  onRemove,
  onClearFinished,
}: {
  jobs: Job[];
  selectedId: string | null;
  now: number;
  onSelect: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onClearFinished: () => void;
}) {
  if (jobs.length === 0) {
    return (
      <p className="py-2 text-[13px] leading-relaxed text-fg-subtle">
        Nothing yet. Generations you run on this device show up here.
      </p>
    );
  }

  const finishedCount = jobs.filter((job) => !isActive(job)).length;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {jobs.map((job) => {
          const selected = job.promptId === selectedId;
          const active = isActive(job);
          const elapsed = active
            ? now - job.submittedAt
            : job.completedAt !== undefined
              ? job.completedAt - job.submittedAt
              : null;

          return (
            <li key={job.promptId}>
              <div
                className={`group flex items-center gap-2 rounded-lg border p-2 transition-colors
                  ${
                    selected
                      ? "border-accent bg-accent-subtle/30"
                      : "border-border-default bg-bg-subtle hover:border-border-strong"
                  }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(job.promptId)}
                  aria-current={selected || undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <Dot tone={PHASE_TONE[job.phase]} pulse={active} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[12px] font-medium text-fg">
                        {PHASE_LABEL[job.phase]}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                        {elapsed !== null ? formatDuration(elapsed) : ""}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
                        {formatWhen(job.submittedAt, now)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-fg-subtle">
                      {job.prompt.trim() || job.workflowName}
                    </span>
                  </span>
                </button>

                {active ? (
                  <button
                    type="button"
                    onClick={() => onCancel(job.promptId)}
                    title="Cancel this generation"
                    aria-label="Cancel this generation"
                    className="grid size-7 shrink-0 place-items-center rounded-md
                      text-fg-muted transition-colors hover:bg-surface hover:text-danger"
                  >
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRemove(job.promptId)}
                    title="Remove from history"
                    aria-label="Remove from history"
                    className="grid size-7 shrink-0 place-items-center rounded-md
                      text-fg-subtle opacity-0 transition-all hover:bg-surface
                      hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                      <path
                        d="M3 4.5h10M6.5 4.5V3.5h3v1M5 4.5l.5 8h5l.5-8"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {finishedCount > 0 ? (
        <button
          type="button"
          onClick={onClearFinished}
          className="self-start text-[12px] font-medium text-fg-muted
            transition-colors hover:text-danger"
        >
          Clear {finishedCount} finished
        </button>
      ) : null}
    </div>
  );
}
