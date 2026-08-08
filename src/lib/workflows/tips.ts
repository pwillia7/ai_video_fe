/**
 * Prompting guidance for the MiniMax H3 workflows, from ComfyUI's tutorial:
 * https://docs.comfy.org/tutorials/video/minimax/minimax-h3
 *
 * Kept as data rather than prose in the UI so each workflow can show only what
 * applies to it — the reference workflow in particular has advice that would be
 * meaningless on the others.
 */

export interface TipSection {
  heading: string;
  items: string[];
}

export interface WorkflowTips {
  sections: TipSection[];
}

const PROMPT_STRUCTURE: TipSection = {
  heading: "Structure the prompt",
  items: [
    "State the whole scene first: where it is, who is in it, and what happens.",
    "Then break it into timed shots.",
    "Keep shots, camera moves and audio in one block. Dialogue, sound effects and music are read together with the visuals, not separately.",
  ],
};

const DURATION_NOTE =
  "Duration snaps to the model's 17-frame grid (17k+5) at 24fps, so a clip can land slightly longer than you asked for.";

export const WORKFLOW_TIPS: Record<string, WorkflowTips> = {
  "minimax-h3": {
    sections: [
      PROMPT_STRUCTURE,
      {
        heading: "Size and length",
        items: [
          "The native canvas is a 768px short edge, capped at 768×1344 and rounded to a multiple of 32.",
          "Frame size defaults to 0.4 MP, which is the fast preview setting. Around 1.0 MP at 16:9 — roughly 1344×768 — is full quality.",
          DURATION_NOTE,
        ],
      },
    ],
  },

  "minimax-h3-i2v": {
    sections: [
      {
        heading: "Working from a first frame",
        items: [
          "Your image is the opening frame and the model generates the motion onward from it.",
          "Describe what happens, not what the image already shows — it can see the image.",
          "The model also accepts a closing frame and will fill the motion between the two. This workflow only wires the first frame.",
        ],
      },
      PROMPT_STRUCTURE,
      { heading: "Length", items: [DURATION_NOTE] },
    ],
  },

  "minimax-h3-ref": {
    sections: [
      {
        heading: "Referring to your images",
        items: [
          "Name each reference by tag, in the order you uploaded it: <Picture 1> for the first, <Picture 2> for the second.",
          "Say what each reference controls — identity, style, motion, camera, voice. The docs are explicit that spelling this out works much better than leaving it implied.",
          "Reference handling: match is faster, max preserves identity better at up to a 2048px short edge.",
          "The model accepts up to 9 reference images. This workflow wires two.",
        ],
      },
      PROMPT_STRUCTURE,
      { heading: "Length", items: [DURATION_NOTE] },
    ],
  },
};

export function tipsFor(workflowId: string): WorkflowTips | undefined {
  return WORKFLOW_TIPS[workflowId];
}
