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
 * The same 4.5 MB request-body cap Vercel enforces before a handler runs, minus
 * a margin. It bites harder here than anywhere else in the app: a few minutes of
 * mp3 is regularly past it, and unlike a photo there is nothing sensible to
 * re-encode in the browser.
 *
 * Which is why the hand-off is the main way a track gets here. Create video on
 * a finished track copies it between ComfyUI's own directories server-side and
 * never moves the bytes through the browser at all, so the cap does not apply.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Picks the track a video is built around, holding the filename ComfyUI returns
 * as the param value.
 *
 * Uploads on selection rather than at submit time, for the same reason as the
 * image and video controls: a file that will not work should fail immediately,
 * not after the user has committed to a multi-minute generation.
 */
export function AudioUpload({
  id,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Read off the loaded track rather than remembered from the upload, so it
   * also describes one that arrived by the hand-off. Undefined until the
   * player has its metadata.
   */
  const [seconds, setSeconds] = useState<number | null>(null);

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      // No probe first, unlike a video: nothing about a track's own shape
      // decides what gets generated — the video's length and size are set by
      // their own controls — so size is the only thing that can disqualify one.
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(
          `That track is ${(file.size / 1024 / 1024).toFixed(1)} MB and the upload limit is ` +
            `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. A track generated here can be sent across ` +
            "with Create video instead, at any size.",
        );
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
      setSeconds(null);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not upload that track.",
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
        accept="audio/*"
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
          <div className="flex flex-col gap-2 p-3">
            {/*
              A remembered reference can outlive the file when ComfyUI's input
              directory is cleared, so a load failure clears the value rather
              than leaving a generation to fail on it later.
            */}
            <audio
              key={previewUrl}
              src={previewUrl}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => {
                const length = event.currentTarget.duration;
                setSeconds(Number.isFinite(length) ? length : null);
              }}
              onError={() => {
                onChange("");
                setSeconds(null);
                setError(
                  "That track is no longer on the ComfyUI server. Choose it again.",
                );
              }}
              className="w-full"
            />
            <div className="flex items-center gap-2">
              {/* min-w-0 is what actually lets `truncate` work: a flex item
                  defaults to min-width:auto and would otherwise refuse to
                  shrink below the filename, pushing the buttons out. */}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
                {value}
              </span>
              {seconds !== null ? (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  {Math.floor(seconds / 60)}:
                  {String(Math.round(seconds % 60)).padStart(2, "0")}
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
                    setSeconds(null);
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
                  {/* A quaver: the stem, its flag, and the notehead. */}
                  <path
                    d="M9.5 17V5.5l8-1.5V15"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <ellipse
                    cx="7.25"
                    cy="17"
                    rx="2.25"
                    ry="2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <ellipse
                    cx="15.25"
                    cy="15"
                    rx="2.25"
                    ry="2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
                <span className="text-[13px] font-medium text-fg">
                  Drop a track or click to choose
                </span>
                <span className="text-[12px] text-fg-subtle">
                  Up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB — or hit Create video
                  on a finished track, which has no size limit
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
