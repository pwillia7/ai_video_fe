import { ComfyError } from "./comfy";
import { ParamError } from "./params";

/**
 * Turn a thrown error into a response the UI can show verbatim. ComfyUI and
 * param errors carry messages written for a human, so they pass through;
 * anything else is logged and reported generically.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof ParamError) {
    return Response.json(
      { error: error.message, field: error.field },
      { status: 400 },
    );
  }

  if (error instanceof ComfyError) {
    return Response.json(
      { error: error.message, detail: error.detail ?? null },
      { status: error.status },
    );
  }

  console.error("Unhandled error in route handler:", error);
  return Response.json(
    { error: "Something went wrong on the server. Check the function logs." },
    { status: 500 },
  );
}
