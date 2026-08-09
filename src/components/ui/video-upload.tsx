"use client";

import { useRef, useState } from "react";
import { Spinner } from "@/components/ui/button";
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
 * so this is a hard ceiling on what can be uploaded here.
 *
 * It is not a ceiling on what the workflow can take. Remix never passes through
 * this route — it asks the server to copy a finished generation between
 * ComfyUI's own directories, so the file never touches the browser.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Picks the video a workflow loads, holding the filename ComfyUI returns as the
 * param value.
 *
 * Uploads on selection rather than at submit time, for the same reason as the
 * image control: a file that will not go through should fail immediately, not
 * after the user has committed to a multi-minute generation.
 */
export function VideoUpload({
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

  const upload = async (file: File) => {
    setError(null);

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `That clip is ${(file.size / 1024 / 1024).toFixed(1)} MB and the upload limit is ` +
          `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Shorten it, or remix a generation from this device instead.`,
      );
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      // api() deliberately leaves the Content-Type off FormData so the browser
      // can set the multipart boundary itself.
      const result = await api<UploadResponse>("/api/upload", {
        method: "POST",
        body: form,
      });
      onChange(result.ref);
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
              Muted and loopable, like any thumbnail: this is here to confirm
              which clip is loaded, not to play it. The soundtrack still
              reaches the workflow — GetVideoComponents reads the file, not
              this element.

              A remembered reference can outlive the file when ComfyUI's input
              directory is cleared, so a load failure clears the value rather
              than leaving a generation to fail on it later.
            */}
            <video
              key={previewUrl}
              src={previewUrl}
              controls
              muted
              loop
              playsInline
              preload="metadata"
              onError={() => {
                onChange("");
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
              <div className="ml-auto flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={disabled || uploading}
                  onClick={() => inputRef.current?.click()}
                  className="text-[11px] font-medium text-fg-muted transition-colors
                    hover:text-fg disabled:opacity-50"
                >
                  Replace
                </button>
                <button
                  type="button"
                  disabled={disabled || uploading}
                  onClick={() => {
                    onChange("");
                    setError(null);
                  }}
                  className="text-[11px] font-medium text-fg-muted transition-colors
                    hover:text-danger disabled:opacity-50"
                >
                  Remove
                </button>
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
                  Or hit Remix on a finished generation
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
