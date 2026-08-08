import { unauthorized } from "@/lib/auth";
import { cancelPrompt } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Stop a generation, whether it is running or still waiting in the queue.
 * The state check lives in comfy.ts, which handles both without a window in
 * which the job can move between checking and acting.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const { promptId } = (await request.json()) as { promptId?: string };
    if (!promptId) throw new ParamError("promptId is required.");

    const cancelled = await cancelPrompt(promptId);
    return Response.json({ cancelled });
  } catch (error) {
    return errorResponse(error);
  }
}
