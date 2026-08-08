import { minimaxH3 } from "./minimax-h3";
import { minimaxH3ImageToVideo } from "./minimax-h3-i2v";
import { minimaxH3Reference } from "./minimax-h3-ref";
import { toSummary, type WorkflowDef, type WorkflowSummary } from "./types";

/**
 * The predetermined set of workflows the app offers. Add a new file next to
 * minimax-h3.ts and register it here — nothing else needs to change.
 */
export const WORKFLOWS: WorkflowDef[] = [
  minimaxH3,
  minimaxH3ImageToVideo,
  minimaxH3Reference,
];

export function getWorkflow(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowSummaries(): WorkflowSummary[] {
  return WORKFLOWS.map(toSummary);
}

export type { WorkflowDef, WorkflowSummary };
