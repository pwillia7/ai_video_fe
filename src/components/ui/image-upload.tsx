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

/** Stay under Vercel's 4.5 MB function request-body limit, with headroom. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 2560;

interface Prepared {
  blob: Blob;
  name: string;
  /** Set when the file was rescaled, so the UI can say so rather than do it silently. */
  note?: string;
}

/**
 * Shrinks oversized images in the browser instead of letting the upload fail.
 *
 * Vercel rejects request bodies over 4.5 MB with a 413 before the handler runs,
 * and a phone photo clears that easily. Downscaling loses nothing in practice:
 * the workflow's ImageScaleToTotalPixels rescales to roughly 1 MP anyway, so a
 * 12 MP original is discarded server-side regardless.
 *
 * Re-encodes as JPEG because alpha is meaningless for a video's first frame.
 */
async function prepareForUpload(file: File): Promise<Prepared> {
  if (file.size <= MAX_UPLOAD_BYTES) return { blob: file, name: file.name };

  const bitmap = await createImageBitmap(file);
  const originalMb = (file.size / 1024 / 1024).toFixed(1);

  try {
    let edge = MAX_EDGE;
    let quality = 0.9;

    // Shrink until it fits. Two or three passes at most in practice.
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (!blob) break;

      if (blob.size <= MAX_UPLOAD_BYTES) {
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return {
          blob,
          name,
          note: `Resized from ${originalMb} MB to ${width}×${height} (${(blob.size / 1024 / 1024).toFixed(1)} MB) to fit the upload limit.`,
        };
      }

      edge = Math.round(edge * 0.75);
      quality = Math.max(0.6, quality - 0.1);
    }
  } finally {
    bitmap.close();
  }

  throw new Error(
    `That image is ${originalMb} MB and could not be shrunk below the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit. Try exporting it smaller.`,
  );
}

/**
 * Uploads to ComfyUI's input directory as soon as a file is chosen, then holds
 * the returned reference as the param value. Uploading on selection rather
 * than at submit time means a bad file is caught immediately instead of
 * failing a generation the user has already committed to.
 */
export function ImageUpload({
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
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Read off the loaded image. Worth showing here because in this workflow the
   * output video inherits the image's dimensions.
   */
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNote(null);
    setDimensions(null);
    try {
      const prepared = await prepareForUpload(file);

      const form = new FormData();
      form.append("file", prepared.blob, prepared.name);
      // api() deliberately leaves the Content-Type off FormData so the browser
      // can set the multipart boundary itself.
      const result = await api<UploadResponse>("/api/upload", {
        method: "POST",
        body: form,
      });

      onChange(result.ref);
      if (prepared.note) setNote(prepared.note);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not upload that image.",
      );
    } finally {
      setUploading(false);
    }
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void upload(file);
  };

  // ComfyUI can serve the file straight back from its input directory, so the
  // preview is the actual uploaded image rather than a local object URL.
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
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
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
            {/* Not next/image: this is proxied through our own route, and the
                dimensions are unknown until ComfyUI has the file.

                Sized by its own aspect ratio rather than w-full: forcing full
                width caps a portrait image at max-height and pads the rest with
                background, which reads as the image not fitting its container. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Selected first frame"
              onLoad={(event) =>
                setDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              className="mx-auto block h-auto max-h-64 w-auto max-w-full object-contain"
            />
            <div className="flex items-center gap-2 border-t border-border-default px-3 py-2">
              {/* min-w-0 is what actually lets `truncate` work: a flex item
                  defaults to min-width:auto and would otherwise refuse to
                  shrink below the filename, pushing the buttons out. */}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
                {value}
              </span>
              {dimensions ? (
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  {dimensions.width}×{dimensions.height}
                </span>
              ) : null}
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
                    setNote(null);
                    setDimensions(null);
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
                    x="3"
                    y="4"
                    width="18"
                    height="16"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[13px] font-medium text-fg">
                  Drop an image or click to choose
                </span>
                <span className="text-[12px] text-fg-subtle">
                  Becomes the first frame of the video
                </span>
              </>
            )}
          </button>
        )}
      </div>

      {error ? (
        <p className="text-[12px] leading-snug text-danger">{error}</p>
      ) : note ? (
        <p className="text-[12px] leading-snug text-fg-subtle">{note}</p>
      ) : null}
    </div>
  );
}
