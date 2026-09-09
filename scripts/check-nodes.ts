/**
 * Checks a ComfyUI install against what the registered workflows actually need.
 *
 *   pnpm check:nodes
 *
 * `check:workflows` proves the definitions agree with their own graphs, which
 * is a question this repo can answer alone. This one asks the question it
 * cannot: whether the machine on the other end has the node classes and model
 * files those graphs name. That is where setting this up actually goes wrong —
 * a missing custom node pack fails at generation time with a ComfyUI error
 * about a class nobody recognises, several minutes after you pressed Generate.
 *
 * It reports the owning package for each class, read off `python_module` in
 * /object_info, so "what do I need to install" is answered by the install
 * itself rather than by a list in the README that goes stale.
 */
import { readFileSync } from "node:fs";
import {
  enumValuesFor,
  gatewayStatus,
  getNodeSchema,
  systemStats,
  type ComfyGraph,
} from "../src/lib/comfy";
import { WORKFLOWS } from "../src/lib/workflows";
import { patchVariants } from "../src/lib/workflows/patches";
import { promptConsumers } from "../src/lib/workflows/director";
import {
  REWRITE_MODELS,
  TEXT_CLASS,
  VISION_CLASS,
} from "../src/lib/workflows/rewrite-model";
import { stepSamplerGraph } from "../src/lib/workflows/step-sampler";
import { turboGraph } from "../src/lib/workflows/turbo";

/**
 * Next loads .env.local for the app; a bare tsx process gets nothing, so do it
 * here. Deliberately does not overwrite anything already in the environment,
 * which is what lets CI pass COMFY_URL without a file on disk.
 */
function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rest] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rest
        .trim()
        .replace(/^["']|["']$/g, "")
        // dotenv turns an escaped \$ into a literal $, and the ComfyUI token is
        // full of them. Matching that here is what keeps this script
        // authenticating the same way the app does.
        .replace(/\\\$/g, "$");
    }
  }
}

/** Loader class -> the input naming the file, for checking models are present. */
const MODEL_INPUTS: Record<string, string> = {
  VAELoader: "vae_name",
  UNETLoader: "unet_name",
  CLIPLoader: "clip_name",
  // Neither of these is in any stored graph — both are spliced in by a switch.
  // See below.
  MiniMaxH3TurboLoRA: "lora_name",
  LoraLoaderModelOnly: "lora_name",
};

interface Need {
  workflows: Set<string>;
  /**
   * True while nothing that *has* to run has named this file.
   *
   * For a switch that offers a choice of checkpoint: you download one of the
   * two, so reporting both as required would leave this check permanently red
   * on a correctly set-up machine and train everyone to ignore it. An optional
   * file that is absent is a line of information, not a failure.
   *
   * Cleared rather than set, so a file named by both a required graph and an
   * optional one stays required — being offered as somebody's fallback is not a
   * reason to stop needing it.
   */
  optional: boolean;
}

function collect() {
  const classes = new Map<string, Need>();
  /** filename -> which loader input it has to appear in. */
  const models = new Map<string, { loader: string; input: string } & Need>();

  /** A graph to check, and whether the run can do without the files it names. */
  interface Candidate {
    label: string;
    graph: ComfyGraph;
    optional?: boolean;
  }

  for (const workflow of WORKFLOWS) {
    // Each mode's graph as well as the stored one. Both are modes rather than
    // second workflows, so the nodes they splice in — and the LoRA files turbo
    // and the style switch name — appear in no graph on disk, and they are
    // exactly the pieces most likely to be missing, since they are the ones
    // that need a custom pack or a separate download.
    //
    // A patch that swaps the base carries its checkpoint the same way: the
    // patched graph loads the bf16 weights the LoRA needs, so this asks whether
    // that file is there rather than only about the quantised one the stored
    // graph names. See `base` on PatchDef.
    //
    // The two are checked separately rather than stacked: what is being asked
    // is whether each class and file exists, and neither node's presence
    // affects the answer for the other.
    const graphs: Candidate[] = [{ label: workflow.id, graph: workflow.graph }];
    if (workflow.turbo) {
      graphs.push({
        label: `${workflow.id} (turbo)`,
        graph: turboGraph(workflow.graph, workflow.turbo),
      });
    }
    for (const patch of workflow.patches ?? []) {
      // Every form the switch can take: one per LoRA it offers, and one more
      // per LoRA that offers a second checkpoint. A switch carrying a list
      // reports each of them optional — see `optional` on Need.
      const promptInputs = workflow.directorBypass
        ? promptConsumers(workflow.graph, workflow.directorBypass)
        : undefined;
      for (const variant of patchVariants(workflow.graph, patch, promptInputs)) {
        graphs.push({
          label: `${workflow.id} (${patch.id}${variant.suffix})`,
          graph: variant.graph,
          optional: variant.optional,
        });
      }
    }
    // And the form the graph takes at the step count that swaps its sampler,
    // which needs no switch at all — so its class would otherwise go unasked
    // about until someone dragged the slider to the end.
    if (workflow.stepSampler) {
      graphs.push({
        label: `${workflow.id} (${workflow.stepSampler.atValue}-step)`,
        graph: stepSamplerGraph(workflow.graph, workflow.stepSampler),
      });
    }
    for (const { label: used, graph, optional = false } of graphs) {
      for (const node of Object.values(graph)) {
        const existing = classes.get(node.class_type);
        if (existing) {
          existing.workflows.add(used);
          if (!optional) existing.optional = false;
        } else {
          classes.set(node.class_type, {
            workflows: new Set([used]),
            optional,
          });
        }

        const input = MODEL_INPUTS[node.class_type];
        if (!input) continue;
        const filename = node.inputs[input];
        if (typeof filename !== "string" || !filename) continue;

        const model = models.get(filename);
        if (model) {
          model.workflows.add(used);
          if (!optional) model.optional = false;
        } else {
          models.set(filename, {
            loader: node.class_type,
            input,
            workflows: new Set([used]),
            optional,
          });
        }
      }
    }
  }

  return { classes, models };
}

/** "custom_nodes.ComfyUI-KJNodes.nodes.image_nodes" -> "ComfyUI-KJNodes". */
function packageOf(pythonModule: string | undefined): string {
  if (!pythonModule) return "unknown";
  if (!pythonModule.startsWith("custom_nodes.")) return "ComfyUI core";
  return pythonModule.split(".")[1] ?? "unknown";
}

async function main() {
  loadEnvFiles();

  if (!process.env.COMFY_URL) {
    console.error(
      "COMFY_URL is not set. Copy .env.example to .env.local and fill it in,\n" +
        "or run with COMFY_URL=http://your-comfyui-host:8188 pnpm check:nodes",
    );
    process.exit(2);
  }

  // Prove we can talk to ComfyUI before asking it thirty questions. Without
  // this, a refused connection or a stale token reports every class as missing,
  // which sends people hunting for node packs they already have.
  await systemStats();

  const { classes, models } = collect();
  console.log(
    `Checking ${classes.size} node classes and ${models.size} model files ` +
      `against ${process.env.COMFY_URL}\n`,
  );

  // Sequential on purpose: a cold ComfyUI answers /object_info slowly, and
  // thirty parallel requests is a rude way to greet it.
  const schemas = new Map<string, Awaited<ReturnType<typeof getNodeSchema>>>();
  for (const className of [...classes.keys()].sort()) {
    schemas.set(className, await getNodeSchema(className));
  }

  const missingClasses: string[] = [];
  const byPackage = new Map<string, string[]>();

  for (const [className, schema] of schemas) {
    if (!schema) {
      missingClasses.push(className);
      continue;
    }
    const pkg = packageOf(schema.python_module);
    const list = byPackage.get(pkg);
    if (list) list.push(className);
    else byPackage.set(pkg, [className]);
  }

  console.log("Node classes");
  for (const pkg of [...byPackage.keys()].sort()) {
    console.log(`  ${pkg}`);
    for (const className of byPackage.get(pkg)!.sort()) {
      console.log(`    ok       ${className}`);
    }
  }
  for (const className of missingClasses) {
    const used = [...classes.get(className)!.workflows].join(", ");
    console.log(`  NOT FOUND  ${className}  — needed by ${used}`);
  }

  console.log("\nModel files");
  const missingModels: string[] = [];
  const absentOptional: string[] = [];
  for (const [filename, need] of models) {
    const installed = enumValuesFor(schemas.get(need.loader) ?? null, need.input);
    if (installed === null) {
      // The loader itself is missing, or ComfyUI did not describe its enum.
      // Already reported above if the class is absent; say nothing more.
      console.log(`  unknown  ${filename}  (could not read ${need.loader}.${need.input})`);
      continue;
    }
    const used = [...need.workflows].join(", ");
    if (installed.includes(filename)) {
      console.log(`  ok       ${filename}`);
    } else if (need.optional) {
      // Absent and that is fine: this is the other side of a choice, and the
      // side actually in use is reported on its own line. Said rather than
      // skipped, so someone looking for why a switch will not run finds it.
      absentOptional.push(filename);
      console.log(`  optional ${filename}  — not installed; only needed by ${used}`);
    } else {
      missingModels.push(filename);
      console.log(`  NOT FOUND  ${filename}  — ${need.loader}.${need.input}, needed by ${used}`);
    }
  }

  // The rewrite model is a model file's opposite number: it lives on someone
  // else's GPU, and what makes it present or absent is whether the gateway
  // still lists it. The node builds its dropdown from that catalog and ComfyUI
  // validates a queued combo against the list, so an id the picker offers and
  // the node does not is a run rejected before it starts — which is exactly the
  // kind of thing this script exists to find before a render does.
  //
  // Asked of both classes, because they answer differently and the difference
  // is load-bearing. `GenerateText` lists every language model the gateway has;
  // `DescribeImage` lists the vision subset, and a model this repo has recorded
  // as seeing images but that is missing from that list is one a graph would
  // hand to a director being shown a picture, and have refused.
  const staleModels: string[] = [];
  if (schemas.get(TEXT_CLASS)) {
    console.log("\nRewrite models");
    const offered = enumValuesFor(schemas.get(TEXT_CLASS) ?? null, "model");
    const sighted = enumValuesFor(schemas.get(VISION_CLASS) ?? null, "model");
    if (offered === null) {
      console.log(`  unknown  (could not read ${TEXT_CLASS}.model)`);
    } else {
      for (const model of REWRITE_MODELS) {
        if (!offered.includes(model.id)) {
          staleModels.push(model.id);
          console.log(
            `  NOT LISTED ${model.id}  — the gateway has stopped offering it`,
          );
        } else if (model.vision && sighted !== null && !sighted.includes(model.id)) {
          staleModels.push(model.id);
          console.log(
            `  NOT VISION ${model.id}  — offered as one that can be shown a picture, and ${VISION_CLASS} does not list it. Run \`pnpm sync:models\`.`,
          );
        } else {
          console.log(
            `  ok       ${model.label}${model.vision ? "" : "  (text only)"}`,
          );
        }
      }
    }

    // And whether any of them can actually be called. A key is not something
    // this repo can hold — it belongs to whoever is running the app — so all
    // that can be checked is whether the machine has one.
    const status = await gatewayStatus().catch(() => null);
    if (status && status.credentials_configured !== true) {
      console.log(
        "  NO KEY   the gateway pack cannot see an API key, so every rewrite will fail.\n" +
          "           Set AI_GATEWAY_API_KEY on the ComfyUI machine, or enter one from\n" +
          "           the key button in the app header.",
      );
    }
  }

  /**
   * What each `optionsFrom` dropdown falls back to when this machine cannot be
   * reached, against what it actually offers.
   *
   * The fallback is not documentation. ComfyUI answers /object_info on the same
   * loop it generates on, so the moment it is worth asking is the moment it is
   * slowest to answer, and a failed lookup is cached for a minute — during
   * which the control shows only what the workflow file declared. A list that
   * has drifted short is a choice the user silently loses, which is how the
   * aspect ratio spent a while offering nothing but portrait.
   *
   * Only "replace" dropdowns. A "restrict" one is curated on purpose: being a
   * subset of the live list is the whole point of it, and it has its own check
   * above.
   */
  console.log("\nDropdown fallbacks");
  const thinFallbacks: string[] = [];
  for (const workflow of WORKFLOWS) {
    for (const param of workflow.params) {
      if (param.type !== "select" || !param.optionsFrom) continue;
      if (param.optionsFrom.mode === "restrict") continue;

      const node = workflow.graph[param.optionsFrom.node];
      const live = enumValuesFor(
        schemas.get(node?.class_type ?? "") ?? null,
        param.optionsFrom.input,
      );
      if (!live || live.length === 0) continue;

      const declared = new Set(param.options.map((option) => option.value));
      const missing = live.filter((value) => !declared.has(value));
      const label = `${workflow.id} ${param.id}`;
      if (missing.length === 0) {
        console.log(`  ok       ${label} — all ${live.length} offered`);
      } else {
        thinFallbacks.push(label);
        console.log(
          `  THIN     ${label} — declares ${declared.size} of ${live.length}, ` +
            `missing ${missing.join(", ")}`,
        );
      }
    }
  }

  if (thinFallbacks.length > 0) {
    console.log(
      `\n${thinFallbacks.length} dropdown(s) fall back to less than this machine offers. ` +
        "Add the missing values to `options` in the workflow file — that list is what\n" +
        "the control shows whenever ComfyUI cannot be reached.",
    );
  }

  if (staleModels.length > 0) {
    console.log(
      `\n${staleModels.length} offered model(s) are no longer in the gateway catalog. ` +
        "Run `pnpm sync:models`.",
    );
  }

  if (missingClasses.length === 0 && missingModels.length === 0) {
    console.log(
      absentOptional.length === 0
        ? "\nEverything the workflows reference is present."
        : `\nEverything required is present. ${absentOptional.length} optional ` +
            "file(s) are not installed; the switches that would use them say so.",
    );
    return;
  }

  console.log("");
  if (missingClasses.length > 0) {
    console.error(
      `${missingClasses.length} node class(es) missing. Install the packs that provide them —\n` +
        "the ComfyUI Manager can search by class name — or edit the graph in\n" +
        "src/lib/workflows/ to stop using them.",
    );
  }
  if (missingModels.length > 0) {
    console.error(
      `${missingModels.length} model file(s) missing. Download them, or change the filename in\n` +
        "the workflow definition to match what you have installed.",
    );
  }
  process.exit(1);
}

main().catch((error) => {
  // A connection failure is the common case here and deserves a plain message
  // rather than a stack trace: this is the script people run when nothing works.
  console.error(
    `\nCould not reach ComfyUI at ${process.env.COMFY_URL}.\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      "Check COMFY_URL, that ComfyUI is running, and that COMFY_API_TOKEN is\n" +
      "current if the login node is enabled.",
  );
  process.exit(2);
});
