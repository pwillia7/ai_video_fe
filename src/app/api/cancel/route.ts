import { unauthorized } from "@/lib/auth";
import { deleteFromQueue, getQueue, interrupt } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Stop a generation. A running prompt needs /interrupt; one still waiting has
 * to be removed from the queue instead, so pick based on where it actually is.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const { promptId } = (await request.json()) as { promptId?: string };
    if (!promptId) throw new ParamError("promptId is required.");

    const queue = await getQueue();
    const isRunning = queue.queue_running?.some(
      (item) => Array.isArray(item) && item[1] === promptId,
    );

    if (isRunning) {
      await interrupt();
    } else {
      await deleteFromQueue(promptId);
    }

    return Response.json({ cancelled: true, wasRunning: Boolean(isRunning) });
  } catch (error) {
    return errorResponse(error);
  }
}
