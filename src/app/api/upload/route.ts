import { unauthorized } from "@/lib/auth";
import { inputFileRef, uploadInputFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Vercel caps a function's request body at 4.5 MB and rejects anything larger
 * with a 413 before the handler runs, so a bigger limit here would just produce
 * an opaque platform error. The client downscales above this threshold.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = /^image\//;

/**
 * Relays a browser file upload into ComfyUI's input directory and returns the
 * reference a LoadImage node needs.
 *
 * Goes through us rather than straight to ComfyUI for the same reasons as
 * everything else: mixed content blocks an HTTPS page from posting to a plain
 * http:// origin, and the ComfyUI credentials never leave the server.
 *
 * Images only. The one workflow that loads a video gets it from Remix, which
 * copies a clip already sitting on the ComfyUI box (see /api/remix) rather
 * than moving bytes through the browser — where 4 MB would not go far anyway.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new ParamError("No file was included in the upload.", "image");
    }
    if (file.size === 0) {
      throw new ParamError("That file is empty.", "image");
    }
    if (file.size > MAX_BYTES) {
      throw new ParamError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
        "image",
      );
    }
    if (file.type && !ACCEPTED.test(file.type)) {
      throw new ParamError(
        `${file.type || "That file"} is not an image.`,
        "image",
      );
    }

    // Strip any path the browser may have included; ComfyUI decides the final
    // name and hands it back.
    const safeName = (file.name || "upload.png").split(/[\\/]/).pop()!;
    const uploaded = await uploadInputFile(file, safeName);

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
