import { unauthorized } from "@/lib/auth";
import { loadImageRef, uploadImage } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BYTES = 32 * 1024 * 1024;
const ACCEPTED = /^image\//;

/**
 * Relays a browser file upload into ComfyUI's input directory and returns the
 * reference a LoadImage node needs.
 *
 * Goes through us rather than straight to ComfyUI for the same reasons as
 * everything else: mixed content blocks an HTTPS page from posting to a plain
 * http:// origin, and the ComfyUI credentials never leave the server.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new ParamError("No image was included in the upload.", "image");
    }
    if (file.size === 0) {
      throw new ParamError("That image file is empty.", "image");
    }
    if (file.size > MAX_BYTES) {
      throw new ParamError(
        `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
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
    const uploaded = await uploadImage(file, safeName);

    return Response.json({
      ref: loadImageRef(uploaded),
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
