"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/panel";
import { withToken } from "@/lib/client";
import {
  dayKey,
  formatDuration,
  formatWhen,
  groupByDay,
  isActive,
  isAudioOnly,
  lineageOrder,
  type Job,
} from "@/lib/jobs";

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

/** Browsers throttle a burst of programmatic downloads; this paces them. */
const DOWNLOAD_STAGGER_MS = 300;

/** What a day's header is asking the user to confirm, if anything. */
type Pending = { day: string; action: "download" | "delete" } | null;

/**
 * Past and in-flight generations for this device, grouped by the day they were
 * started.
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
  onRemoveMany,
  onClearFinished,
}: {
  jobs: Job[];
  selectedId: string | null;
  now: number;
  onSelect: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onRemoveMany: (promptIds: string[]) => void;
  onClearFinished: () => void;
}) {
  /**
   * Per-day open state, but only where the user has said otherwise: the newest
   * day is open by default and the rest are closed, so a long history collapses
   * to a readable index without hiding what was just made. Keying on the day
   * rather than the position means a new day inherits the default rather than
   * whatever the day above it was set to.
   */
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const [pending, setPending] = useState<Pending>(null);

  /**
   * One player for the whole list, rather than one per row.
   *
   * Two things fall out of that and both are wanted. Only one track can play at
   * a time, because there is only one element to play it — starting a second
   * row replaces the source of the first. And it sits outside the day sections,
   * so collapsing the day a playing track is in does not unmount the thing
   * playing it.
   */
  const player = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const toggleTrack = useCallback(
    (job: Job) => {
      const element = player.current;
      const file = job.outputs[0];
      if (!element || !file) return;

      if (playingId === job.promptId) {
        element.pause();
        setPlayingId(null);
        return;
      }

      element.src = withToken(file.url);
      setPlayingId(job.promptId);
      // Rejects when a second row replaces this source mid-load, and when the
      // file is no longer in ComfyUI's output directory — the same way a
      // deleted generation stops playing in the stage. Either way the button
      // goes back to offering a play, which is the honest report of what
      // happened.
      void element.play().catch(() => setPlayingId(null));
    },
    [playingId],
  );

  // A track whose row has just been forgotten has no pause button left to
  // press, so it is stopped here rather than left playing out of nowhere.
  useEffect(() => {
    if (playingId === null) return;
    if (jobs.some((job) => job.promptId === playingId)) return;
    player.current?.pause();
    setPlayingId(null);
  }, [jobs, playingId]);

  // Keyed on the calendar day rather than on `now`, which ticks every second
  // while anything is running. All `now` decides here is whether a heading says
  // "Today", so regrouping the whole history a second at a time was buying one
  // label change at midnight.
  const today = dayKey(now);
  const groups = useMemo(
    // `now` is read through `today`, which is what the dependency list names.
    () => groupByDay(jobs, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, today],
  );

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
      <div className="flex flex-col gap-3">
        {groups.map((group, index) => {
          const open = openOverrides[group.key] ?? index === 0;
          const downloadable = group.jobs.filter(
            (job) => job.outputs.length > 0,
          );
          const confirming = pending?.day === group.key ? pending.action : null;

          return (
            <section key={group.key}>
              {/* The confirmation takes the whole row rather than squeezing in
                  beside the toggle: the question needs the width, and there is
                  nothing else worth doing while it is being asked. */}
              <header className="mb-1.5 flex h-6 items-center gap-2">
                {confirming ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenOverrides((previous) => ({
                        ...previous,
                        [group.key]: !open,
                      }))
                    }
                    aria-expanded={open}
                    className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className={`size-3 shrink-0 text-fg-subtle transition-transform duration-200
                        ${open ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    >
                      <path
                        d="M6 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span
                      className="truncate text-[11px] font-medium uppercase tracking-[0.08em]
                        text-fg-subtle transition-colors group-hover:text-fg-muted"
                    >
                      {group.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                      {group.jobs.length}
                    </span>
                  </button>
                )}

                {confirming ? (
                  <ConfirmBar
                    action={confirming}
                    count={
                      confirming === "download"
                        ? downloadable.length
                        : group.jobs.length
                    }
                    onCancel={() => setPending(null)}
                    onConfirm={() => {
                      if (confirming === "download") downloadAll(downloadable);
                      else onRemoveMany(group.jobs.map((job) => job.promptId));
                      setPending(null);
                    }}
                  />
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {downloadable.length > 0 ? (
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={() =>
                          setPending({ day: group.key, action: "download" })
                        }
                      >
                        Download
                      </Button>
                    ) : null}
                    <Button
                      variant="quiet-danger"
                      size="xs"
                      onClick={() =>
                        setPending({ day: group.key, action: "delete" })
                      }
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </header>

              {open ? (
                <ul className="flex flex-col gap-1.5">
                  {lineageOrder(group.jobs).map(({ job, depth }) => (
                    <li
                      key={job.promptId}
                      // Indented under whatever it was made from, with a
                      // rule down the left so a source and its takes read as
                      // one thing rather than as neighbours.
                      className={
                        depth > 0
                          ? "ml-3 border-l border-border-default pl-3"
                          : undefined
                      }
                      style={
                        depth > 1
                          ? { marginLeft: `${depth * 0.75}rem` }
                          : undefined
                      }
                    >
                      <Row
                        job={job}
                        now={now}
                        selected={job.promptId === selectedId}
                        playing={job.promptId === playingId}
                        onSelect={onSelect}
                        onCancel={onCancel}
                        onRemove={onRemove}
                        onToggleTrack={toggleTrack}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      {finishedCount > 0 ? (
        <Button
          variant="quiet-danger"
          size="xs"
          className="mt-1 self-start"
          onClick={onClearFinished}
        >
          Clear {finishedCount} finished
        </Button>
      ) : null}

      {/* No `controls`, so it draws nothing: the row's own button is the
          transport. The stage is where a track gets a scrubber — this is here
          so playing one does not mean scrolling back up to it. */}
      <audio
        ref={player}
        onEnded={() => setPlayingId(null)}
        onError={() => setPlayingId(null)}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * Confirmation in place of the actions it replaces, rather than a dialog.
 * Both of these are one click from a mis-hit and one of them is destructive,
 * but neither is weighty enough to be worth taking over the screen — and the
 * question reads better sitting on the row it applies to.
 */
function ConfirmBar({
  action,
  count,
  onConfirm,
  onCancel,
}: {
  action: "download" | "delete";
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // "generations" rather than "videos": a selection can now hold music too,
  // and the bar counts whatever is ticked without looking at what it is.
  const noun = `${count} ${count === 1 ? "generation" : "generations"}`;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
        {action === "download"
          ? `Download ${noun}?`
          : /* Naming what survives: the files themselves are on the ComfyUI
               box and this only forgets where they are. */
            `Forget ${noun}? Files stay on the server.`}
      </span>
      <Button
        variant={action === "delete" ? "quiet-danger" : "quiet"}
        size="xs"
        onClick={onConfirm}
      >
        {action === "download" ? "Download" : "Delete"}
      </Button>
      <Button variant="quiet" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function Row({
  job,
  now,
  selected,
  playing,
  onSelect,
  onCancel,
  onRemove,
  onToggleTrack,
}: {
  job: Job;
  now: number;
  selected: boolean;
  /** Whether the panel's player is on this row's track right now. */
  playing: boolean;
  onSelect: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onToggleTrack: (job: Job) => void;
}) {
  const active = isActive(job);
  /**
   * A track can be played from the row it is on, without selecting it.
   *
   * Selecting is what the rest of the row does, and it puts the generation in
   * the stage — which on a long history is a scroll away, so hearing a track
   * you made an hour ago meant going up to the top and then finding your place
   * again. Only audio gets this: a video needs the picture, which is the
   * stage's job.
   */
  const playable = !active && isAudioOnly(job);
  const elapsed = active
    ? now - job.submittedAt
    : job.completedAt !== undefined
      ? job.completedAt - job.submittedAt
      : null;

  return (
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
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-subtle">
            {/* Which kind of file this row leads to, for a list that now holds
                two. Deliberately small and in the muted colour the line it sits
                on already uses: it is a distinction worth being able to see at
                a glance and not worth a badge. Nothing marks a video — the
                absence is the other half of the signal, and marking both would
                put a glyph on every row and distinguish nothing. */}
            {isAudioOnly(job) ? (
              <svg
                viewBox="0 0 16 16"
                className="size-2.5 shrink-0"
                fill="none"
                role="img"
                aria-label="Audio"
              >
                <path
                  d="M6 11.5V3.5l6-1.2v8"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="4.5" cy="11.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="10.5" cy="10.3" r="1.7" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            ) : null}
            <span className="min-w-0 truncate">
              {job.prompt.trim() || job.workflowName}
            </span>
          </span>
        </span>
      </button>

      {/* Always visible, unlike the remove button beside it, which appears on
          hover: this is something to reach for rather than a tidy-up, and a
          touch device has no hover to reveal it with. */}
      {playable ? (
        <button
          type="button"
          onClick={() => onToggleTrack(job)}
          title={playing ? "Pause" : "Play this track"}
          aria-label={playing ? "Pause" : "Play this track"}
          aria-pressed={playing}
          className={`grid size-7 shrink-0 place-items-center rounded-md
            transition-colors hover:bg-surface hover:text-fg
            ${playing ? "text-accent" : "text-fg-muted"}`}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path
                d="M6 3.5v9M10 3.5v9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path
                d="M5.5 3.6v8.8l7-4.4-7-4.4Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      ) : null}

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
  );
}

/**
 * Saves each generation's primary output, one anchor click at a time.
 *
 * Staggered because browsers treat a burst of programmatic downloads as
 * suspicious and drop all but the first. Chrome also asks once per site
 * whether to allow multiple files, which is part of why this is behind a
 * confirmation — the prompt makes more sense when it was expected.
 *
 * Deliberately not cancelled if the panel unmounts: the user asked for the
 * files, and navigating away should not take back the ones still queued.
 */
function downloadAll(jobs: Job[]): void {
  jobs
    .map((job) => job.outputs[0])
    .filter((file) => file !== undefined)
    .forEach((file, index) => {
      setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = withToken(file.url);
        anchor.download = file.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * DOWNLOAD_STAGGER_MS);
    });
}
