import { isAuthRequired } from "@/lib/auth";
import { generationTimeoutMs } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Public. Tells the UI whether it must collect an access token before it can
 * do anything else. Deliberately reveals nothing about the ComfyUI endpoint.
 */
export async function GET() {
  return Response.json({
    authRequired: isAuthRequired(),
    generationTimeoutSeconds: Math.round(generationTimeoutMs() / 1000),
  });
}
