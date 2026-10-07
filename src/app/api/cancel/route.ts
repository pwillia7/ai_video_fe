import { unauthorized } from "@/lib/auth";
import { cancelPrompt, getHistoryEntry, getQueue } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { graphOf, livePasses, runKey } from "@/lib/meta-batch";
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

    // A batched run is several prompts, and the one this app submitted may be
    // long finished. Find what the run is called — from the queue while its
    // first slice is still there, from history once it is not — and stop
    // every pass of it, not just the id the client holds. See meta-batch.ts.
    const queue = await getQueue();
    const own = [...queue.queue_running, ...queue.queue_pending].find(
      (item) => item[1] === promptId,
    );
    const key =
      runKey(graphOf(own)) ??
      runKey(graphOf((await getHistoryEntry(promptId))?.prompt));

    const passes = key
      ? livePasses(queue, key)
          .map((item) => item[1])
          .filter((id): id is string => typeof id === "string" && id !== promptId)
      : [];

    const [cancelled] = await Promise.all([
      cancelPrompt(promptId),
      ...passes.map((id) => cancelPrompt(id)),
    ]);
    return Response.json({ cancelled: cancelled || passes.length > 0 });
  } catch (error) {
    return errorResponse(error);
  }
}
