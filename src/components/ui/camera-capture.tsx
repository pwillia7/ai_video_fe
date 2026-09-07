"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

/** Shared by the buttons that open the capture modal. */
export function CameraIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path
        d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2a1 1 0 0 0 .83-.45l.73-1.1A1 1 0 0 1 9.1 5h5.8a1 1 0 0 1 .84.45l.73 1.1a1 1 0 0 0 .83.45h2.2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.4" r="3.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Which way the camera points. Phones have both; a laptop has neither. */
type Facing = "environment" | "user";

/**
 * Whether this browser can open a camera at all.
 *
 * `mediaDevices` is undefined outside a secure context, which is the usual
 * reason this is false: the deployed app is HTTPS and localhost counts, but a
 * dev server reached over the LAN by IP does not. Checking `isSecureContext`
 * as well as the API means the button is hidden rather than offering a
 * permission prompt that can never be granted.
 *
 * Must be called from an effect, never during render — the server has no
 * navigator, and a button that appears only on the client would mismatch.
 */
export function cameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    window.isSecureContext
  );
}

/**
 * getUserMedia's failures, in words that say what to do about them.
 *
 * Exported because the video recorder opens the same camera through the same
 * API and fails in exactly the same ways — with one addition of its own, since
 * it asks for the microphone too and a machine can have a camera and no mic.
 */
export function explainCameraError(cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was blocked. Allow it for this site in your browser’s settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera found on this device.";
    case "NotReadableError":
      return "The camera is already in use by another app or tab.";
    default:
      return cause instanceof Error
        ? cause.message
        : "Could not open the camera.";
  }
}

/**
 * Takes a photo with the device's own camera and hands it back as a File, so
 * it goes through exactly the same upload path as one picked off disk.
 *
 * The alternative — `<input capture>` — is a one-liner, but it only does
 * anything on a phone: a desktop browser ignores the attribute and opens the
 * file picker, which is the behaviour that was already there. getUserMedia
 * covers the laptop webcam and the phone with the same control.
 */
export function CameraCapture({
  open,
  onClose,
  onCapture,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  /** What the picture is for, echoed in the modal header. */
  subtitle?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facing, setFacing] = useState<Facing>("environment");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taking, setTaking] = useState(false);
  /** Whether there is a second camera worth offering to switch to. */
  const [canFlip, setCanFlip] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // Dropping the reference is not enough on its own: a <video> holding a
    // stopped stream keeps the last frame on screen, which reads as a live
    // camera that has frozen.
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!open) {
      stop();
      setReady(false);
      setError(null);
      return;
    }

    // The modal can close, or the camera be flipped, while getUserMedia is
    // still resolving. Without this the orphaned stream stays live and the
    // recording indicator stays lit.
    let cancelled = false;

    (async () => {
      setError(null);
      setReady(false);
      stop();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // `ideal`, not `exact`: a laptop webcam reports no facing mode at
          // all, and an exact constraint would fail outright rather than
          // giving back the only camera there is.
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // Safari rejects this if the element is not allowed to autoplay
          // inline; the attributes on the element below are what permit it.
          await video.play().catch(() => {});
        }
        setReady(true);

        // Labels are only populated once permission has been granted, so this
        // has to come after the stream, not before it.
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setCanFlip(
            devices.filter((device) => device.kind === "videoinput").length > 1,
          );
        }
      } catch (cause) {
        if (!cancelled) setError(explainCameraError(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, facing, stop]);

  // Belt and braces: closing the modal runs the effect above, but unmounting
  // while it is open — a workflow switched, the panel torn down — would not.
  useEffect(() => stop, [stop]);

  const take = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    setTaking(true);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setTaking(false);
      setError("Could not read a frame from the camera.");
      return;
    }
    // Drawn unmirrored even when the preview is flipped, which is what every
    // phone does: a mirrored preview helps you aim, a mirrored photo has
    // backwards text in it.
    context.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        setTaking(false);
        if (!blob) {
          setError("Could not read a frame from the camera.");
          return;
        }
        onCapture(
          new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }),
        );
        onClose();
      },
      "image/jpeg",
      0.92,
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take a photo"
      subtitle={subtitle}
      footer={
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={take}
            loading={taking}
            disabled={!ready}
          >
            Take photo
          </Button>
          {canFlip ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={!ready}
              onClick={() =>
                setFacing((was) =>
                  was === "environment" ? "user" : "environment",
                )
              }
            >
              Flip camera
            </Button>
          ) : null}
          <Button
            variant="quiet"
            size="sm"
            className="ml-auto"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      }
    >
      <div className="relative overflow-hidden rounded-lg bg-black">
        {/* muted + playsInline are what let this autoplay at all on iOS;
            without them Safari refuses and the preview stays black. */}
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className="mx-auto block max-h-[50vh] w-full bg-black object-contain"
          // Mirrored only for the front camera, so moving left moves left.
          style={
            facing === "user" ? { transform: "scaleX(-1)" } : undefined
          }
        />

        {!ready && !error ? (
          <div className="absolute inset-0 grid place-items-center gap-2 text-white/70">
            <div className="flex flex-col items-center gap-2">
              <Spinner className="size-5" />
              <span className="text-[13px]">Opening the camera…</span>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="text-[12px] leading-snug text-danger">{error}</p>
      ) : (
        <p className="text-[12px] leading-snug text-fg-subtle">
          The photo is uploaded to ComfyUI as soon as you take it, the same as
          a file you choose yourself.
        </p>
      )}
    </Modal>
  );
}
