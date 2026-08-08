/**
 * Verifies every registered workflow's param targets resolve against its graph.
 * Run after editing a workflow file or swapping in a new ComfyUI export:
 *
 *   pnpm check:workflows
 */
import { validateWorkflow } from "../src/lib/params";
import { WORKFLOWS } from "../src/lib/workflows";

let failed = false;

for (const workflow of WORKFLOWS) {
  const problems = validateWorkflow(workflow);
  const nodeCount = Object.keys(workflow.graph).length;

  if (problems.length === 0) {
    console.log(
      `  ok   ${workflow.id} — ${workflow.params.length} params over ${nodeCount} nodes`,
    );
    continue;
  }

  failed = true;
  console.error(`  FAIL ${workflow.id}`);
  for (const problem of problems) console.error(`       ${problem}`);
}

if (failed) {
  console.error(
    "\nOne or more workflows are out of sync with their graph. Fix the `targets` in the workflow file.",
  );
  process.exit(1);
}

console.log(`\n${WORKFLOWS.length} workflow(s) valid.`);
