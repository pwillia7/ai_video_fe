"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cameraAvailable, explainCameraError } from "@/components/ui/camera-capture";
import { Modal } from "@/components/ui/modal";

/** Which way the camera points. Phones have both; a laptop has neither. */
type Facing = "environment" | "user";

/**
 * The rate to record at, which is the rate MiniMax H3 reads a reference video
 * at. See the workflow's own REF_VIDEO_FPS — duplicated rather than imported
 * because nothing under src/lib/workflows may be pulled into a client bundle.
 */
const REF_VIDEO_FPS = 24;

/**
 * The container this browser will record into, best first.
 *
 * MP4 leads for one reason: what comes out of here is uploaded to ComfyUI and
 * opened by PyAV, and every clip that has ever gone through this app by hand
 * was an MP4. WebM decodes too — ComfyUI lists a file by its guessed MIME type
 * and `.webm` guesses to `video/webm` — but it is the less-travelled path, so
 * it is where this falls back to rather than where it starts.
 *
 * Firefox records WebM and nothing else, so the fallback is not hypothetical.
 */
const CONTAINERS: Array<{ mimeType: string; extension: string }> = [
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

/** The first container this browser admits to supporting, or null for none. */
function pickContainer(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    CONTAINERS.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate.mimeType),
    ) ?? null
  );
}

/**
 * Whether this browser can record a clip at all.
 *
 * Everything `cameraAvailable` needs, plus a MediaRecorder that will produce
 * some container we can name. Checked together because a button offering to
 * record on a browser that cannot is worse than no button: the failure would
 * land after permission had been granted and the camera light was on.
 *
 * Must be called from an effect, never during render — the server has neither
 * `navigator` nor `MediaRecorder`.
 */
export function videoCaptureAvailable(): boolean {
  return cameraAvailable() && pickContainer() !== null;
}

/** mm:ss, for a counter that never runs past a minute in practice. */
function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Records a clip with the device's own camera and hands it back as a File, so
 * it goes through exactly the same upload and validation path as one picked off
 * disk.
 *
 * The size limit is what shapes this. A recording cannot be re-encoded smaller
 * afterwards the way an oversized photo can, and the upload ceiling is a hard
 * 4 MB, so the bitrate is budgeted *before* recording starts from the limit and
 * the longest clip allowed: exceed it and there is nothing to do but ask for
 * the take again. The recorder also stops itself at that length rather than
 * trusting anyone to watch a counter.
 */
export function VideoCapture({
  open,
  onClose,
  onCapture,
  subtitle,
  maxSeconds,
  maxBytes,
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  /** What the clip is for, echoed in the modal header. */
  subtitle?: string;
  /** Where the recorder stops itself, and what the bitrate is budgeted for. */
  maxSeconds: number;
  /** The upload ceiling the budget has to land under. */
  maxBytes: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /**
   * Set while the recording is being stopped on purpose, so `onstop` knows the
   * difference between a finished take and a modal that was closed underneath
   * it. Without it, cancelling would still hand a clip back.
   */
  const keepRef = useRef(false);

  const [facing, setFacing] = useState<Facing>("environment");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** Whether there is a second camera worth offering to switch to. */
  const [canFlip, setCanFlip] = useState(false);

  /**
   * Bits per second for the whole file, budgeted at 80% of the ceiling: a
   * MediaRecorder treats a bitrate as a target rather than a promise, and the
   * headroom covers the container's own overhead and its aim being off.
   */
  const audioBitsPerSecond = 96_000;
  const videoBitsPerSecond = Math.max(
    300_000,
    Math.floor((maxBytes * 8 * 0.8) / maxSeconds) - audioBitsPerSecond,
  );

  const stop = useCallback(() => {
    // Ordered: the recorder first, so a take in progress is torn down before
    // the tracks feeding it disappear.
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // Dropping the reference is not enough on its own: a <video> holding a
    // stopped stream keeps the last frame on screen, which reads as a live
    // camera that has frozen.
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!open) {
      keepRef.current = false;
      stop();
      setReady(false);
      setRecording(false);
      setElapsed(0);
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
          //
          // 1280x720 rather than the 1920x1080 a photo asks for, because this
          // is the shape the model takes: a reference clip is capped at a
          // 768px short edge, and recording larger would only spend the
          // bitrate budget on pixels that get scaled away.
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // 24, because that is the rate H3 reads a reference video at and
            // nothing downstream can resample a recording to it: the frames are
            // cut out of a decoded batch by index, so their spacing is whatever
            // the camera produced. Recording at the target rate is what makes a
            // recorded clip play at its real speed — at 30 it would come back
            // a fifth slow, at 60 half speed.
            frameRate: { ideal: REF_VIDEO_FPS },
          },
          // The soundtrack is half the point of attaching a clip rather than a
          // still, so the microphone is asked for with the camera.
          audio: true,
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

  /**
   * The counter, and the thing that actually enforces the length.
   *
   * Driven off a clock rather than off the recorder because MediaRecorder has
   * no length limit of its own, and a clip that overruns is one the upload will
   * refuse after the take rather than during it.
   */
  useEffect(() => {
    if (!recording) return;

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const seconds = (Date.now() - startedAt) / 1000;
      setElapsed(seconds);
      if (seconds >= maxSeconds) finish();
    }, 100);

    return () => window.clearInterval(timer);
    // `finish` is stable for the life of a recording — it only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, maxSeconds]);

  const start = () => {
    const stream = streamRef.current;
    const container = pickContainer();
    if (!stream || !container) {
      setError("This browser cannot record video.");
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: container.mimeType,
        videoBitsPerSecond,
        audioBitsPerSecond,
      });
      chunksRef.current = [];
      keepRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setRecording(false);
        setError("The recording stopped unexpectedly. Try again.");
      };
      recorder.onstop = () => {
        setRecording(false);
        const chunks = chunksRef.current;
        chunksRef.current = [];
        // Closed rather than finished: the tracks are already going away and
        // there is nothing to hand back.
        if (!keepRef.current || chunks.length === 0) return;

        const blob = new Blob(chunks, { type: container.mimeType });
        onCapture(
          new File([blob], `camera-${Date.now()}.${container.extension}`, {
            type: container.mimeType,
          }),
        );
        onClose();
      };

      // A timeslice, so a long take arrives in pieces rather than as one
      // allocation at the end.
      recorder.start(1000);
      recorderRef.current = recorder;
      setElapsed(0);
      setError(null);
      setRecording(true);
    } catch {
      setError("This browser refused to start a recording.");
    }
  };

  /** Ends the take and keeps it. Distinct from `stop`, which throws it away. */
  const finish = () => {
    keepRef.current = true;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const remaining = Math.max(0, maxSeconds - elapsed);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a clip"
      subtitle={subtitle}
      footer={
        <div className="flex items-center gap-2">
          {recording ? (
            <Button variant="primary" size="sm" onClick={finish}>
              Stop and use
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={start}
              disabled={!ready}
            >
              Start recording
            </Button>
          )}
          {canFlip && !recording ? (
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
        {/*
          muted + playsInline are what let this autoplay at all on iOS; without
          them Safari refuses and the preview stays black. Muted also stops the
          microphone this stream carries from feeding straight back out of the
          speakers, which it would otherwise do the moment the preview started.
        */}
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`block max-h-[60vh] w-full ${
            facing === "user" ? "-scale-x-100" : ""
          }`}
        />

        {recording ? (
          <div
            className="absolute left-3 top-3 flex items-center gap-2 rounded-full
              bg-black/70 px-2.5 py-1 font-mono text-[11px] tabular-nums text-white"
          >
            <span className="size-2 animate-pulse rounded-full bg-danger" />
            {clock(elapsed)} / {clock(maxSeconds)}
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 text-[12px] leading-snug text-danger">{error}</p>
      ) : (
        <p className="mt-3 text-[12px] leading-snug text-fg-subtle">
          {recording
            ? `Recording stops on its own in ${Math.ceil(remaining)}s.`
            : `Up to ${maxSeconds}s, with sound. It records at a bitrate that keeps the file under the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`}
        </p>
      )}
    </Modal>
  );
}
