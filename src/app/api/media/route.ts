import { unauthorized } from "@/lib/auth";
import { contentTypeFor, viewFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_TYPES = new Set(["output", "temp", "input"]);

/**
 * Reject anything that could climb out of ComfyUI's output directory. ComfyUI
 * does its own checking, but this route is the internet-facing edge of it.
 */
function assertSafePath(value: string, field: string): void {
  if (value.includes("..") || value.startsWith("/") || value.includes("\\")) {
    throw new ParamError(`Invalid ${field}.`, field);
  }
}

/**
 * Streams a generated file from ComfyUI through to the browser. This exists
 * because the page is served over HTTPS and ComfyUI is plain HTTP — the
 * browser would refuse to load the video directly.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const search = new URL(request.url).searchParams;
    const filename = search.get("filename");
    const subfolder = search.get("subfolder") ?? "";
    const type = search.get("type") ?? "output";

    if (!filename) throw new ParamError("filename is required.", "filename");
    assertSafePath(filename, "filename");
    assertSafePath(subfolder, "subfolder");
    if (!ALLOWED_TYPES.has(type)) throw new ParamError("Invalid type.", "type");

    // Forward Range so the browser can seek within the video.
    const range = request.headers.get("range");
    const upstream = await viewFile(
      { filename, subfolder, type },
      {
        headers: range ? { Range: range } : undefined,
        signal: request.signal,
      },
    );

    const headers = new Headers();
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") ?? contentTypeFor(filename),
    );
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set(
      "Content-Disposition",
      `inline; filename="${filename.replace(/"/g, "")}"`,
    );

    for (const header of ["content-length", "content-range", "etag"]) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
