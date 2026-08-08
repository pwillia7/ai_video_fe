"use client";

import { Badge, Dot } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { withToken } from "@/lib/client";
import type { GenerationController } from "@/hooks/use-generation";

/**
 * The right-hand canvas: empty state, live progress, failure, or the finished
 * video. Only one of these is ever on screen.
 */
export function GenerationStage({
  generation,
  onReuseSeed,
  hasAudio = false,
}: {
  generation: GenerationController;
  onReuseSeed?: (seed: number) => void;
  hasAudio?: boolean;
}) {
  const { phase } = generation;

  return (
    <div className="flex min-h-[420px] flex-col">
      {phase === "done" && generation.outputs.length > 0 ? (
        <Result
          generation={generation}
          onReuseSeed={onReuseSeed}
          hasAudio={hasAudio}
        />
      ) : phase === "error" ? (
        <Failure generation={generation} />
      ) : generation.isBusy ? (
        <InFlight generation={generation} />
      ) : phase === "cancelled" ? (
        <Cancelled generation={generation} />
      ) : (
        <Empty />
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
        bg-bg-subtle p-8 text-center ${
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
          Pick a workflow, write a prompt, and generate. The result appears here
          and stays until the next run.
        </p>
      </div>
    </Frame>
  );
}

const PHASE_COPY: Record<string, { label: string; detail: string }> = {
  submitting: {
    label: "Submitting",
    detail: "Handing the graph to ComfyUI.",
  },
  queued: {
    label: "Queued",
    detail: "Waiting for the GPU to free up.",
  },
  running: {
    label: "Generating",
    detail: "Sampling frames. This is the slow part.",
  },
};

function InFlight({ generation }: { generation: GenerationController }) {
  const { phase, elapsedMs, estimatedSeconds, queuePosition } = generation;
  const copy = PHASE_COPY[phase] ?? PHASE_COPY.running;

  const elapsedSeconds = elapsedMs / 1000;
  // ComfyUI exposes no step-level progress over HTTP, so this curve is an
  // estimate that eases toward 95% and never claims to be finished.
  const fraction = estimatedSeconds
    ? Math.min(0.95, 1 - Math.exp(-elapsedSeconds / (estimatedSeconds * 0.55)))
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

        {/* Determinate when we have an estimate, indeterminate sweep otherwise. */}
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
          {queuePosition !== null && queuePosition > 0
            ? `${queuePosition} job${queuePosition === 1 ? "" : "s"} ahead of this one.`
            : copy.detail}
        </p>

        {estimatedSeconds ? (
          <p className="mt-1 text-[12px] text-fg-subtle">
            Typically about {formatDuration(estimatedSeconds * 1000)} for this
            workflow.
          </p>
        ) : null}

        <div className="mt-5">
          <Button size="sm" variant="danger" onClick={generation.cancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function Failure({ generation }: { generation: GenerationController }) {
  return (
    <Frame>
      <div className="w-full max-w-md">
        <div className="mb-3 flex items-center justify-center gap-2">
          <Dot tone="danger" />
          <span className="text-sm font-medium text-fg">
            Generation failed
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {generation.error}
        </p>
        <div className="mt-5">
          <Button size="sm" onClick={generation.reset}>
            Dismiss
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function Cancelled({ generation }: { generation: GenerationController }) {
  return (
    <Frame dashed>
      <div className="flex items-center gap-2">
        <Dot tone="warning" />
        <span className="text-sm font-medium text-fg">Cancelled</span>
      </div>
      <Button size="sm" onClick={generation.reset}>
        Start over
      </Button>
    </Frame>
  );
}

function Result({
  generation,
  onReuseSeed,
  hasAudio,
}: {
  generation: GenerationController;
  onReuseSeed?: (seed: number) => void;
  hasAudio?: boolean;
}) {
  const [primary, ...rest] = generation.outputs;
  const seed = generation.resolved?.seed;
  const src = withToken(primary.url);

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border-default bg-black">
        {/*
          key on src so switching results tears down the old media element
          instead of trying to swap the source underneath it.
        */}
        {/*
          Silent workflows autoplay on a loop, which is the nicer preview.
          Audio workflows must not: autoplay is only allowed while muted, so
          looping it muted would hide the soundtrack entirely.
        */}
        <video
          key={src}
          src={src}
          controls
          autoPlay={!hasAudio}
          loop={!hasAudio}
          muted={!hasAudio}
          playsInline
          className="block max-h-[60vh] w-full bg-black"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">
          <Dot tone="success" /> Done
        </Badge>
        <Badge mono>{primary.filename}</Badge>
        {typeof seed === "number" ? (
          <Badge mono>seed {seed}</Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {typeof seed === "number" && onReuseSeed ? (
            <Button size="sm" variant="ghost" onClick={() => onReuseSeed(seed)}>
              Reuse seed
            </Button>
          ) : null}
          <a
            href={src}
            download={primary.filename}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border
              border-border-default bg-surface px-3 text-[13px] font-medium
              text-fg transition-colors hover:border-border-strong hover:bg-surface-hover"
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
          This run also produced {rest.length} other file
          {rest.length === 1 ? "" : "s"}:{" "}
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

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
