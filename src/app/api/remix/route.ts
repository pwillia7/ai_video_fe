import { unauthorized } from "@/lib/auth";
import { inputFileRef, uploadInputFile, viewFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { isUnsafePath, ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Copies a finished generation into ComfyUI's input directory so it can be fed
 * back in as a reference video.
 *
 * The two directories are separate: a LoadVideo node only sees what is in
 * `input`, and everything a workflow produces lands in `output`. So a clip has
 * to be copied across before it can be reused, and nothing in ComfyUI's HTTP
 * API does that in one call.
 *
 * The copy runs server-side rather than by handing the browser a download and
 * taking an upload back: a generated clip is comfortably past the 4.5 MB
 * Vercel caps a request body at, and the round trip would move the same bytes
 * over the user's connection twice for no reason. Here they stay between this
 * function and the ComfyUI box.
 */

const SOURCE_TYPES = new Set(["output", "temp", "input"]);

/**
 * Bounded because the file is buffered in memory to be re-posted as multipart.
 * Far above what these workflows produce — a clip of a few seconds is single
 * digit megabytes — so it only catches something pathological.
 */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Checked again here rather than trusted from the caller. The stage keeps a
 * matching list to decide whether to offer the button at all (`REMIXABLE` in
 * generation-stage.tsx), but that one is an affordance, not a guard.
 */
const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|mov|m4v)$/i;

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const body = (await request.json()) as {
      filename?: string;
      subfolder?: string;
      type?: string;
    };

    const filename = body.filename?.trim();
    const subfolder = body.subfolder?.trim() ?? "";
    const type = body.type?.trim() || "output";

    if (!filename) throw new ParamError("filename is required.", "filename");
    if (isUnsafePath(filename)) {
      throw new ParamError("Invalid filename.", "filename");
    }
    if (isUnsafePath(subfolder)) {
      throw new ParamError("Invalid subfolder.", "subfolder");
    }
    if (!SOURCE_TYPES.has(type)) {
      throw new ParamError("Invalid type.", "type");
    }
    if (!VIDEO_EXTENSIONS.test(filename)) {
      throw new ParamError(
        "Only a video can be used as a reference clip.",
        "filename",
      );
    }

    // Already where LoadVideo looks — a clip that was itself uploaded, or one
    // remixed twice. Copying it onto itself would be pointless work.
    if (type === "input") {
      return Response.json({
        ref: subfolder ? `${subfolder}/${filename}` : filename,
        name: filename,
        subfolder,
        type,
      });
    }

    const upstream = await viewFile({ filename, subfolder, type });

    // Refuse on the declared length before reading, so an implausible file is
    // rejected without pulling it into memory first.
    const declared = Number(upstream.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      await upstream.body?.cancel();
      throw new ParamError(
        `That video is ${(declared / 1024 / 1024).toFixed(0)} MB, which is too large to reuse as a reference.`,
        "filename",
      );
    }

    const blob = await upstream.blob();
    if (blob.size === 0) {
      throw new ParamError(
        "That video is no longer on the ComfyUI server.",
        "filename",
      );
    }
    if (blob.size > MAX_BYTES) {
      throw new ParamError(
        `That video is ${(blob.size / 1024 / 1024).toFixed(0)} MB, which is too large to reuse as a reference.`,
        "filename",
      );
    }

    // Overwrite: the name comes from ComfyUI's own output directory and is
    // unique per generation, so remixing the same clip twice should land on
    // the one file rather than accumulating copies.
    const uploaded = await uploadInputFile(blob, filename, { overwrite: true });

    return Response.json({
      ref: inputFileRef(uploaded),
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
