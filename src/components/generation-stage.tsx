"use client";

import { Badge, Dot } from "@/components/ui/panel";
import { Button, buttonClasses } from "@/components/ui/button";
import { withToken } from "@/lib/client";
import { formatDuration, type Job } from "@/lib/jobs";

/**
 * The canvas: whichever generation is being viewed. Progress while it runs,
 * the video once it lands, or the reason it did not.
 */
export function GenerationStage({
  job,
  now,
  estimateSeconds,
  onCancel,
  onReuseSeed,
  onRemix,
  onShowSettings,
  remixing = false,
}: {
  job: Job | null;
  /** Ticking clock, so the elapsed timer advances between poll results. */
  now: number;
  /** Learned from this device's history; falls back to the workflow's guess. */
  estimateSeconds: number | null;
  onCancel: (promptId: string) => void;
  onReuseSeed?: (seed: number) => void;
  /** Absent when no registered workflow can take a clip as a reference. */
  onRemix?: (job: Job) => void;
  /** Opens the record of what this generation was run with. */
  onShowSettings?: () => void;
  /** The copy into ComfyUI's input directory is still in flight. */
  remixing?: boolean;
}) {
  return (
    <div className="flex min-h-[320px] flex-col sm:min-h-[420px]">
      {!job ? (
        <Empty />
      ) : job.phase === "done" && job.outputs.length > 0 ? (
        <Result
          job={job}
          onReuseSeed={onReuseSeed}
          onRemix={onRemix}
          onShowSettings={onShowSettings}
          remixing={remixing}
        />
      ) : job.phase === "error" ? (
        <Failure job={job} onShowSettings={onShowSettings} />
      ) : job.phase === "cancelled" || job.phase === "unknown" ? (
        <Closed job={job} />
      ) : (
        <InFlight
          job={job}
          now={now}
          estimateSeconds={estimateSeconds}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function Frame({
  children,
  dashed = false,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-4 rounded-xl
        bg-bg-subtle p-6 text-center sm:p-8 ${
          dashed
            ? "border border-dashed border-border-strong"
            : "border border-border-default"
        }`}
    >
      {children}
    </div>
  );
}

function Empty() {
  return (
    <Frame dashed>
      <svg
        viewBox="0 0 24 24"
        className="size-8 text-fg-subtle"
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="2.5"
          y="5.5"
          width="19"
          height="13"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M10 9.5l4.5 2.5L10 14.5v-5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <p className="text-sm font-medium text-fg">No video yet</p>
        <p className="mx-auto mt-1 max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          Pick a workflow, write a prompt, and generate. You can queue more than
          one — they run in order.
        </p>
      </div>
    </Frame>
  );
}

const PHASE_COPY: Record<string, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Waiting for the GPU to free up." },
  running: { label: "Generating", detail: "Sampling frames. This is the slow part." },
};

function InFlight({
  job,
  now,
  estimateSeconds,
  onCancel,
}: {
  job: Job;
  now: number;
  estimateSeconds: number | null;
  onCancel: (promptId: string) => void;
}) {
  const copy = PHASE_COPY[job.phase] ?? PHASE_COPY.running;
  const elapsedMs = now - job.submittedAt;

  // Progress is measured from when rendering began, not when the job was
  // accepted — otherwise time spent queued behind other jobs would show up as
  // progress that has not happened.
  const renderingMs = job.startedAt ? now - job.startedAt : 0;
  const renderingSeconds = renderingMs / 1000;

  // ComfyUI publishes no step-level progress over HTTP, so this is a curve
  // against the expected duration. It eases toward 95% and never claims to be
  // finished, because it does not actually know.
  const fraction =
    job.startedAt && estimateSeconds
      ? Math.min(0.95, 1 - Math.exp(-renderingSeconds / (estimateSeconds * 0.55)))
      : null;

  const remainingSeconds =
    job.startedAt && estimateSeconds
      ? Math.max(0, Math.round(estimateSeconds - renderingSeconds))
      : null;

  return (
    <Frame>
      <div className="w-full max-w-sm">
        <div className="mb-3 flex items-center justify-center gap-2">
          <Dot tone="accent" pulse />
          <span className="text-sm font-medium text-fg">{copy.label}</span>
          <span className="font-mono text-[13px] tabular-nums text-fg-muted">
            {formatDuration(elapsedMs)}
          </span>
        </div>

        <div className="relative h-1 w-full overflow-hidden rounded-full bg-track">
          {fraction === null ? (
            <div className="sweep absolute inset-0" />
          ) : (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
              style={{ width: `${fraction * 100}%` }}
            />
          )}
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-fg-subtle">
          {job.queuePosition !== null && job.queuePosition > 0
            ? `${job.queuePosition} job${job.queuePosition === 1 ? "" : "s"} ahead of this one.`
            : copy.detail}
        </p>

        {remainingSeconds !== null ? (
          <p className="mt-1 text-[12px] text-fg-subtle">
            {remainingSeconds > 0
              ? `About ${formatDuration(remainingSeconds * 1000)} left, going on previous runs.`
              : "Taking longer than previous runs."}
          </p>
        ) : null}

        <div className="mt-5">
          <Button size="sm" variant="danger" onClick={() => onCancel(job.promptId)}>
            Cancel
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function Failure({
  job,
  onShowSettings,
}: {
  job: Job;
  onShowSettings?: () => void;
}) {
  return (
    <Frame>
      <div className="w-full max-w-md">
        <div className="mb-3 flex items-center justify-center gap-2">
          <Dot tone="danger" />
          <span className="text-sm font-medium text-fg">Generation failed</span>
        </div>
        <p className="text-[13px] leading-relaxed text-fg-muted">{job.error}</p>
        {/* Worth reaching most from here: the first question after a failure
            is usually what it was run with. */}
        {onShowSettings ? (
          <div className="mt-5">
            <Button size="sm" variant="quiet" onClick={onShowSettings}>
              View settings
            </Button>
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

function Closed({ job }: { job: Job }) {
  return (
    <Frame dashed>
      <div className="flex items-center gap-2">
        <Dot tone="warning" />
        <span className="text-sm font-medium text-fg">
          {job.phase === "cancelled" ? "Cancelled" : "No longer tracked"}
        </span>
      </div>
      {job.phase === "unknown" ? (
        <p className="mx-auto max-w-xs text-[13px] leading-relaxed text-fg-subtle">
          ComfyUI no longer has a record of this job. It was probably restarted
          since.
        </p>
      ) : null}
    </Frame>
  );
}

/** What can be fed back in as a reference clip; a still cannot. */
const REMIXABLE = /\.(mp4|webm|mkv|mov|m4v)$/i;

function Result({
  job,
  onReuseSeed,
  onRemix,
  onShowSettings,
  remixing,
}: {
  job: Job;
  onReuseSeed?: (seed: number) => void;
  onRemix?: (job: Job) => void;
  onShowSettings?: () => void;
  remixing?: boolean;
}) {
  const [primary, ...rest] = job.outputs;
  const seed = job.resolved?.seed;
  const src = withToken(primary.url);
  const canRemix = Boolean(onRemix) && REMIXABLE.test(primary.filename);
  const took =
    job.completedAt !== undefined
      ? formatDuration(job.completedAt - job.submittedAt)
      : null;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border-default bg-black">
        {/*
          Silent workflows autoplay on a loop, which is the nicer preview.
          Audio workflows must not: autoplay is only allowed while muted, so
          looping it muted would hide the soundtrack entirely.
        */}
        <video
          key={src}
          src={src}
          controls
          autoPlay={!job.hasAudio}
          loop={!job.hasAudio}
          muted={!job.hasAudio}
          playsInline
          className="block max-h-[60vh] w-full bg-black"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">
          <Dot tone="success" /> Done
        </Badge>
        {took ? <Badge mono>{took}</Badge> : null}
        {typeof seed === "number" ? <Badge mono>seed {seed}</Badge> : null}

        <div className="ml-auto flex items-center gap-2">
          {onShowSettings ? (
            <Button size="sm" variant="quiet" onClick={onShowSettings}>
              Settings
            </Button>
          ) : null}
          {typeof seed === "number" && onReuseSeed ? (
            <Button size="sm" variant="quiet" onClick={() => onReuseSeed(seed)}>
              Reuse seed
            </Button>
          ) : null}
          {canRemix ? (
            <Button
              size="sm"
              variant="secondary"
              loading={remixing}
              onClick={() => onRemix?.(job)}
              title="Use this clip as the reference for a new generation"
              icon={
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                  <path
                    d="M10 2.5l2 2-2 2M6 13.5l-2-2 2-2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 4.5H6a2.5 2.5 0 0 0-2.5 2.5M4 11.5h6A2.5 2.5 0 0 0 12.5 9"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              }
            >
              Remix
            </Button>
          ) : null}
          {/* An anchor, not a button: `download` is what saves the file, and
              there is no way to keep that on a <button>. Borrowing the button
              recipe keeps it from drifting out of step with the row. */}
          <a
            href={src}
            download={primary.filename}
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path
                d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            Download
          </a>
        </div>
      </div>

      {rest.length > 0 ? (
        <p className="text-[12px] text-fg-subtle">
          Also produced{" "}
          {rest.map((file, index) => (
            <span key={file.url}>
              {index > 0 ? ", " : ""}
              <a
                href={withToken(file.url)}
                download={file.filename}
                className="font-mono text-accent hover:underline"
              >
                {file.filename}
              </a>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
