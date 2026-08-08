import { unauthorized } from "@/lib/auth";
import { resolveDynamicOptions } from "@/lib/dynamic-options";
import { errorResponse } from "@/lib/errors";
import { validateWorkflow } from "@/lib/params";
import { WORKFLOWS } from "@/lib/workflows";
import { toSummary } from "@/lib/workflows/types";

export const dynamic = "force-dynamic";

/** The parameter schema for every registered workflow. Graphs stay server-side. */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    // Surface a broken mapping here rather than at generation time.
    const problems = WORKFLOWS.flatMap((workflow) =>
      validateWorkflow(workflow).map((p) => `${workflow.id}: ${p}`),
    );
    if (problems.length > 0) {
      console.error("Invalid workflow definitions:", problems);
    }

    // Fill select options from the live ComfyUI schema so the dropdowns match
    // what this install actually supports. Degrades to the static lists if
    // ComfyUI is unreachable rather than failing the request.
    const workflows = await Promise.all(
      WORKFLOWS.map(async (workflow) =>
        toSummary({
          ...workflow,
          params: await resolveDynamicOptions(workflow),
        }),
      ),
    );

    return Response.json({
      workflows,
      problems: problems.length > 0 ? problems : undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
