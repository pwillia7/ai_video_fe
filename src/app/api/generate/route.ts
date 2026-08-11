import { unauthorized } from "@/lib/auth";
import { queuePrompt } from "@/lib/comfy";
import { allowedValuesFor } from "@/lib/dynamic-options";
import { errorResponse } from "@/lib/errors";
import { applyParams, ParamError, validateWorkflow } from "@/lib/params";
import { getWorkflow } from "@/lib/workflows";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Queue a generation. Returns as soon as ComfyUI accepts the job — the client
 * then polls /api/status. We never hold the request open for the whole render:
 * a video can take many minutes and no function timeout would survive it.
 */
export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const body = (await request.json()) as {
      workflowId?: string;
      params?: Record<string, unknown>;
      turbo?: boolean;
    };

    if (!body.workflowId) {
      throw new ParamError("No workflow selected.");
    }

    const workflow = getWorkflow(body.workflowId);
    if (!workflow) {
      throw new ParamError(`Unknown workflow "${body.workflowId}".`);
    }

    // A mode rather than a workflow of its own: the LoRA is spliced into the
    // graph on the way past. See src/lib/workflows/turbo.ts.
    const turbo = body.turbo === true;
    if (turbo && !workflow.turbo) {
      throw new ParamError(`Workflow "${workflow.id}" has no turbo mode.`);
    }

    const problems = validateWorkflow(workflow);
    if (problems.length > 0) {
      return Response.json(
        {
          error: `Workflow "${workflow.id}" is misconfigured and was not submitted.`,
          detail: problems,
        },
        { status: 500 },
      );
    }

    // Validate selects against the live enum lists, so a value that is valid on
    // this ComfyUI install is not rejected by a stale hardcoded list.
    const allowedValues: Record<string, string[] | null> = {};
    await Promise.all(
      workflow.params.map(async (param) => {
        if (param.type !== "select") return;
        allowedValues[param.id] = await allowedValuesFor(workflow, param);
      }),
    );

    const { graph, resolved } = applyParams(
      workflow,
      body.params ?? {},
      allowedValues,
      turbo,
    );

    const clientId = crypto.randomUUID();
    const result = await queuePrompt(graph, clientId);

    return Response.json({
      promptId: result.prompt_id,
      queueNumber: result.number,
      clientId,
      resolved,
      estimatedSeconds:
        (turbo ? workflow.turbo?.estimatedSeconds : undefined) ??
        workflow.estimatedSeconds ??
        null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
