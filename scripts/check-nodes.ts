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
import { enumValuesFor, getNodeSchema, systemStats } from "../src/lib/comfy";
import { WORKFLOWS } from "../src/lib/workflows";
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
  // Not in any stored graph — it is spliced in for turbo. See below.
  MiniMaxH3TurboLoRA: "lora_name",
};

interface Need {
  workflows: Set<string>;
}

function collect() {
  const classes = new Map<string, Need>();
  /** filename -> which loader input it has to appear in. */
  const models = new Map<string, { loader: string; input: string } & Need>();

  for (const workflow of WORKFLOWS) {
    // The turbo graph as well as the stored one. Turbo is a mode rather than a
    // second workflow, so the LoRA node and its file appear in no graph on
    // disk — and they are exactly the pieces most likely to be missing, since
    // they are the only ones that need a custom pack.
    const graphs = [workflow.graph];
    if (workflow.turbo) {
      graphs.push(turboGraph(workflow.graph, workflow.turbo));
    }
    for (const [index, graph] of graphs.entries()) {
      const used = index === 0 ? workflow.id : `${workflow.id} (turbo)`;
      for (const node of Object.values(graph)) {
        const existing = classes.get(node.class_type);
        if (existing) existing.workflows.add(used);
        else classes.set(node.class_type, { workflows: new Set([used]) });

        const input = MODEL_INPUTS[node.class_type];
        if (!input) continue;
        const filename = node.inputs[input];
        if (typeof filename !== "string" || !filename) continue;

        const model = models.get(filename);
        if (model) model.workflows.add(used);
        else {
          models.set(filename, {
            loader: node.class_type,
            input,
            workflows: new Set([used]),
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
  for (const [filename, need] of models) {
    const installed = enumValuesFor(schemas.get(need.loader) ?? null, need.input);
    if (installed === null) {
      // The loader itself is missing, or ComfyUI did not describe its enum.
      // Already reported above if the class is absent; say nothing more.
      console.log(`  unknown  ${filename}  (could not read ${need.loader}.${need.input})`);
      continue;
    }
    if (installed.includes(filename)) {
      console.log(`  ok       ${filename}`);
    } else {
      missingModels.push(filename);
      const used = [...need.workflows].join(", ");
      console.log(`  NOT FOUND  ${filename}  — ${need.loader}.${need.input}, needed by ${used}`);
    }
  }

  if (missingClasses.length === 0 && missingModels.length === 0) {
    console.log("\nEverything the workflows reference is present.");
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
