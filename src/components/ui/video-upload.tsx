"use client";

import { useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { api, ApiError, withToken } from "@/lib/client";

interface UploadResponse {
  ref: string;
  name: string;
  subfolder: string;
  type: string;
}

/**
 * Vercel rejects a request body over 4.5 MB with a 413 before the handler runs.
 * An oversized photo can be re-encoded in the browser to fit; a video cannot,
 * so this is a hard ceiling rather than something to work around.
 *
 * It does not apply to Remix or Extend, which copy a clip between ComfyUI's own
 * directories server-side and never move the bytes through the browser.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Both workflows that take a clip generate at its own dimensions — a remix at
 * the size of its frames, an extension at the size of its last one — so an
 * oversized clip is not merely slow, it asks the model for a canvas it was
 * never built for. MiniMax H3's is a 768px short edge, capped at 768x1344.
 *
 * Checked here rather than server-side because reading a video's dimensions
 * needs a decoder, and the browser already has one. Catching it before the
 * upload also saves sending a file that was never going to work.
 */
const MAX_LONG_EDGE = 1344;
const MAX_SHORT_EDGE = 768;
/** The same ceiling the generating workflows put on their own duration. */
const MAX_SECONDS = 20;

interface Probe {
  width: number;
  height: number;
  seconds: number;
}

/**
 * Pull dimensions and duration out of a file before uploading it.
 *
 * Doubles as a format check: anything the browser cannot decode fails here,
 * which is a fair proxy for what ComfyUI's own decoder will accept.
 */
function probe(file: File): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      fn();
    };

    video.onloadedmetadata = () =>
      done(() =>
        resolve({
          width: video.videoWidth,
          height: video.videoHeight,
          seconds: video.duration,
        }),
      );
    video.onerror = () =>
      done(() =>
        reject(
          new Error(
            "That file could not be read as a video. Try an MP4, WebM or MOV.",
          ),
        ),
      );

    video.src = url;
  });
}

/** The reason a clip cannot be used, or null when it can. */
function rejectionFor(file: File, { width, height, seconds }: Probe): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return (
      `That clip is ${(file.size / 1024 / 1024).toFixed(1)} MB and the limit is ` +
      `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Trim it, or export it at a lower bitrate.`
    );
  }

  if (!width || !height) {
    return "That file has no video track to work from.";
  }

  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > MAX_LONG_EDGE || short > MAX_SHORT_EDGE) {
    return (
      `That clip is ${width}x${height}. The new video is generated at its size, ` +
      `and this model tops out around ${MAX_SHORT_EDGE}x${MAX_LONG_EDGE} — scale it down first.`
    );
  }

  if (Number.isFinite(seconds) && seconds > MAX_SECONDS) {
    return (
      `That clip runs ${seconds.toFixed(1)}s and the limit is ${MAX_SECONDS}s. ` +
      "A long source is a long wait however it is used."
    );
  }

  return null;
}

/**
 * Picks the clip a workflow is built from — remixed or continued — holding the
 * filename ComfyUI returns as the param value.
 *
 * Uploads on selection rather than at submit time, for the same reason as the
 * image control: a file that will not work should fail immediately, not after
 * the user has committed to a multi-minute generation.
 */
export function VideoUpload({
  id,
  value,
  onChange,
  onMeasure,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * The loaded clip's running time in seconds, or 0 when nothing is loaded.
   * Reported from the preview below rather than from `probe`, so it covers a
   * clip that arrived by Remix or Extend as well as one that was uploaded.
   */
  onMeasure?: (seconds: number) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Read off the loaded clip rather than remembered from the upload, so it also
   * describes a clip that arrived by Remix or Extend — and so the numbers shown
   * are the ones the workflow will actually generate at.
   */
  const [spec, setSpec] = useState<Probe | null>(null);

  /**
   * The one place `spec` is set, so the measurement reported upward can never
   * drift from the one displayed. A duration that is not a finite number —
   * which a stream or a still-loading file will give — reports as 0, the same
   * as no clip at all.
   */
  const applySpec = (next: Probe | null) => {
    setSpec(next);
    onMeasure?.(
      next && Number.isFinite(next.seconds) ? Math.max(0, next.seconds) : 0,
    );
  };

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const rejection = rejectionFor(file, await probe(file));
      if (rejection) {
        setError(rejection);
        return;
      }

      const form = new FormData();
      form.append("file", file, file.name);
      // api() deliberately leaves the Content-Type off FormData so the browser
      // can set the multipart boundary itself.
      const result = await api<UploadResponse>("/api/upload", {
        method: "POST",
        body: form,
      });
      onChange(result.ref);
      // Cleared rather than carried over from `probe`: the preview re-measures
      // the file ComfyUI actually stored, which is the one that will be used.
      applySpec(null);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not upload that video.",
      );
    } finally {
      setUploading(false);
    }
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void upload(file);
  };

  // Played back out of ComfyUI's input directory, so the preview is the file
  // the workflow will actually load rather than a local object URL — which
  // also means a reference that has gone stale shows up here as an error.
  const previewUrl = value
    ? withToken(
        `/api/media?${new URLSearchParams({
          filename: value.split("/").pop() ?? value,
          subfolder: value.includes("/")
            ? value.slice(0, value.lastIndexOf("/"))
            : "",
          type: "input",
        })}`,
      )
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="video/*"
        className="sr-only"
        disabled={disabled || uploading}
        aria-describedby={describedBy}
        onChange={(event) => pick(event.target.files)}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && !uploading) pick(event.dataTransfer.files);
        }}
        className={`relative overflow-hidden rounded-lg border transition-colors
          ${previewUrl ? "border-solid" : "border-dashed"}
          ${
            dragging
              ? "border-accent bg-accent-subtle/30"
              : previewUrl
                ? "border-border-default bg-bg-subtle"
                : "border-border-strong bg-bg-subtle"
          } ${disabled ? "opacity-50" : ""}`}
      >
        {previewUrl ? (
          <div className="relative">
            {/*
              Controls but no autoplay: this is here so you can check which clip
              is loaded, and a source clip usually has a soundtrack that
              autoplay would force to be muted anyway.

              A remembered reference can outlive the file when ComfyUI's input
              directory is cleared, so a load failure clears the value rather
              than leaving a generation to fail on it later.
            */}
            <video
              key={previewUrl}
              src={previewUrl}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) =>
                applySpec({
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                  seconds: event.currentTarget.duration,
                })
              }
              onError={() => {
                onChange("");
                applySpec(null);
                setError(
                  "That video is no longer on the ComfyUI server. Choose it again.",
                );
              }}
              className="mx-auto block max-h-64 w-full bg-black"
            />
            <div className="flex items-center gap-2 border-t border-border-default px-3 py-2">
              {/* min-w-0 is what actually lets `truncate` work: a flex item
                  defaults to min-width:auto and would otherwise refuse to
                  shrink below the filename, pushing the buttons out. */}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
                {value}
              </span>
              {spec ? (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  {spec.width}×{spec.height}
                  {Number.isFinite(spec.seconds)
                    ? ` · ${spec.seconds.toFixed(1)}s`
                    : ""}
                </span>
              ) : null}
              <div className="ml-auto flex shrink-0 gap-2">
                <Button
                  variant="quiet"
                  size="xs"
                  disabled={disabled || uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  Replace
                </Button>
                <Button
                  variant="quiet-danger"
                  size="xs"
                  disabled={disabled || uploading}
                  onClick={() => {
                    onChange("");
                    setError(null);
                    applySpec(null);
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 px-4 py-8
              text-center transition-colors hover:bg-surface-hover disabled:pointer-events-none"
          >
            {uploading ? (
              <>
                <Spinner className="size-5 text-fg-muted" />
                <span className="text-[13px] text-fg-muted">Uploading…</span>
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  className="size-7 text-fg-subtle"
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
                <span className="text-[13px] font-medium text-fg">
                  Drop a video or click to choose
                </span>
                <span className="text-[12px] text-fg-subtle">
                  Up to {MAX_SHORT_EDGE}×{MAX_LONG_EDGE}, {MAX_SECONDS}s and{" "}
                  {MAX_UPLOAD_BYTES / 1024 / 1024} MB — or hit Remix or Extend
                  on a finished generation
                </span>
              </>
            )}
          </button>
        )}
      </div>

      {error ? (
        <p className="text-[12px] leading-snug text-danger">{error}</p>
      ) : null}
    </div>
  );
}
