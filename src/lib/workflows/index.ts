import { minimaxH3 } from "./minimax-h3";
import { minimaxH3Extend } from "./minimax-h3-extend";
import { minimaxH3ImageToVideo } from "./minimax-h3-i2v";
import { minimaxH3Reference } from "./minimax-h3-ref";
import { minimaxH3ReferenceTurbo } from "./minimax-h3-ref-turbo";
import { minimaxH3ReferenceVideo } from "./minimax-h3-ref2v";
import { toSummary, type WorkflowDef, type WorkflowSummary } from "./types";

/**
 * The predetermined set of workflows the app offers. Add a new file next to
 * minimax-h3.ts and register it here — nothing else needs to change.
 */
export const WORKFLOWS: WorkflowDef[] = [
  minimaxH3,
  minimaxH3ImageToVideo,
  minimaxH3Reference,
  minimaxH3ReferenceTurbo,
  minimaxH3ReferenceVideo,
  minimaxH3Extend,
];

export function getWorkflow(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowSummaries(): WorkflowSummary[] {
  return WORKFLOWS.map(toSummary);
}

export type { WorkflowDef, WorkflowSummary };
