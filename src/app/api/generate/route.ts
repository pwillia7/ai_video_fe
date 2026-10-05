import { unauthorized } from "@/lib/auth";
import { enumValuesFor, getNodeSchema, queuePrompt } from "@/lib/comfy";
import { allowedValuesFor } from "@/lib/dynamic-options";
import { errorResponse } from "@/lib/errors";
import { applyParams, ParamError, validateWorkflow } from "@/lib/params";
import { getWorkflow } from "@/lib/workflows";
import {
  findLocalDirectorFile,
  LOCAL_DIRECTOR_SECONDS,
  LOCAL_LOADER_CLASS,
  localDirectorModel,
} from "@/lib/workflows/local-director";
import { enabledPatches } from "@/lib/workflows/patches";

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
      lowVram?: boolean;
      patches?: string[];
      lora?: Record<string, string>;
      tier?: Record<string, string>;
      strengths?: Record<string, number>;
      alternateBase?: Record<string, boolean>;
      director?: string;
      localDirector?: string;
    };

    if (!body.workflowId) {
      throw new ParamError("No workflow selected.");
    }

    const workflow = getWorkflow(body.workflowId);
    if (!workflow) {
      throw new ParamError(`Unknown workflow "${body.workflowId}".`);
    }

    // Modes rather than workflows of their own: each splices a node into the
    // graph on the way past, and they stack. See src/lib/workflows/modes.ts.
    const turbo = body.turbo === true;
    if (turbo && !workflow.turbo) {
      throw new ParamError(`Workflow "${workflow.id}" has no turbo mode.`);
    }
    const patches = Array.isArray(body.patches) ? body.patches : [];
    for (const id of patches) {
      if (!workflow.patches?.some((patch) => patch.id === id)) {
        throw new ParamError(`Workflow "${workflow.id}" has no "${id}" switch.`);
      }
    }
    // Ignored rather than refused off turbo: the input it sets belongs to the
    // LoRA node, which a standard run never splices in, so there is nothing
    // for it to be wrong about.
    const lowVram = turbo && body.lowVram === true;
    // Numbers only, and only for switches this workflow has. Clamping to each
    // control's own range is `applyPatch`'s job, since the range lives with the
    // patch that declares it.
    const strengths: Record<string, number> = {};
    for (const [id, value] of Object.entries(body.strengths ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        strengths[id] = value;
      }
    }
    // Ids only, resolved against the workflow's own list on the way past — an
    // id naming no entry falls back to the default rather than failing.
    const lora: Record<string, string> = {};
    for (const [id, value] of Object.entries(body.lora ?? {})) {
      if (typeof value === "string" && value) lora[id] = value;
    }
    const tier: Record<string, string> = {};
    for (const [id, value] of Object.entries(body.tier ?? {})) {
      if (typeof value === "string" && value) tier[id] = value;
    }
    // Booleans only. Which file each side means is this side's business — the
    // browser is never given either filename. See `PatchBaseAlternate`.
    const alternateBase: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(body.alternateBase ?? {})) {
      if (typeof value === "boolean") alternateBase[id] = value;
    }

    // Which file the local director is, found on this install rather than sent
    // by the browser: the browser names a model, never a path, and the file is
    // matched by what it is because what it was saved as varies. See
    // `LocalDirectorModel.match`.
    let localDirector: string | undefined;
    if (body.director === "local") {
      const model = localDirectorModel(body.localDirector);
      const files = enumValuesFor(
        await getNodeSchema(LOCAL_LOADER_CLASS),
        "clip_name",
      );
      if (!files) {
        throw new ParamError(
          "Could not ask ComfyUI which text encoders it has, so the local director cannot be found. Try again in a minute, or switch the director back to the AI Gateway.",
        );
      }
      localDirector = findLocalDirectorFile(model, files);
      if (!localDirector) {
        throw new ParamError(
          `The local director is chosen but ${model.label} is not in ComfyUI's models/text_encoders folder. Download it from ${model.download}, or switch the director back to the AI Gateway.`,
        );
      }
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

    // `applied` is what the run actually got: the step count can refuse a
    // switch that was asked for, and the answer has to reach the client or the
    // history would name a mode the graph did not have. See `suppresses`.
    const {
      graph,
      resolved,
      patches: applied,
      loras: appliedLoras,
    } = applyParams(workflow, body.params ?? {}, allowedValues, {
      turbo,
      lowVram,
      patches,
      lora,
      tier,
      strengths,
      alternateBase,
      localDirector,
    });

    const clientId = crypto.randomUUID();
    const result = await queuePrompt(graph, clientId);

    return Response.json({
      promptId: result.prompt_id,
      queueNumber: result.number,
      clientId,
      resolved,
      patches: applied,
      // Which LoRA each switch actually applied, and at what — sent back for
      // the same reason `applied` is rather than being assumed from the
      // request: an id that no longer names an entry resolved to the default.
      loras: appliedLoras,
      // Echoed for the same reason: the history buckets render times by how a
      // run was made, and a local brief adds a minute and a half to it.
      localDirector: localDirector !== undefined,
      // Only ever a starting point: the client replaces it with this machine's
      // own median for this workflow and these modes as soon as it has one, so
      // the fact that neither number describes both switches at once costs a
      // rough progress bar on the first run in a combination and nothing after.
      estimatedSeconds: withLocalDirector(
        enabledPatches(workflow.patches, applied)
          .map((patch) => patch.estimatedSeconds)
          .findLast((seconds) => seconds !== undefined) ??
          (turbo ? workflow.turbo?.estimatedSeconds : undefined) ??
          workflow.estimatedSeconds ??
          null,
        localDirector !== undefined,
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The gateway-run estimate, plus what writing the brief on the box costs. */
function withLocalDirector(
  seconds: number | null,
  local: boolean,
): number | null {
  return seconds !== null && local ? seconds + LOCAL_DIRECTOR_SECONDS : seconds;
}
