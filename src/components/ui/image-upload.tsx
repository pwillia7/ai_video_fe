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
  const [dragging, setDragging] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      // No Content-Type header: the browser must set the multipart boundary.
      const result = await api<UploadResponse>("/api/upload", {
        method: "POST",
        body: form,
      });
      onChange(result.ref);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Could not upload that image.",
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
        className={`relative overflow-hidden rounded-lg border border-dashed transition-colors
          ${
            dragging
              ? "border-accent bg-accent-subtle/30"
              : "border-border-strong bg-bg-subtle"
          } ${disabled ? "opacity-50" : ""}`}
      >
        {previewUrl ? (
          <div className="relative">
            {/* Not next/image: this is proxied through our own route, and the
                dimensions are unknown until ComfyUI has the file. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Selected first frame"
              className="block max-h-56 w-full bg-black object-contain"
            />
            <div className="flex items-center gap-2 border-t border-border-default px-3 py-2">
              <span className="truncate font-mono text-[11px] text-fg-muted">
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
      ) : null}
    </div>
  );
}
