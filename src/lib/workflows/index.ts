import { minimaxH3 } from "./minimax-h3";
import { textToVideo, textToVideoDraft } from "./text-to-video";
import { toSummary, type WorkflowDef, type WorkflowSummary } from "./types";

/**
 * The predetermined set of workflows the app offers. Add a new file next to
 * text-to-video.ts and register it here — nothing else needs to change.
 */
export const WORKFLOWS: WorkflowDef[] = [
  minimaxH3,
  textToVideo,
  textToVideoDraft,
];

export function getWorkflow(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowSummaries(): WorkflowSummary[] {
  return WORKFLOWS.map(toSummary);
}

export type { WorkflowDef, WorkflowSummary };
