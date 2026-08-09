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
      {
        heading: "Your prompt gets expanded first",
        items: [
          "A director model rewrites what you type into a full scene description — shots, performance, camera and sound — before the video model reads it.",
          "So a single sentence is a valid prompt here. Two samurai fight on a rooftop in Hong Kong is enough to work with.",
          "Anything you do specify is preserved: style, dialogue, setting, an explicit shot list. The rewrite elaborates your idea rather than replacing it.",
          "The less you say, the more the rewrite decides for you. Spell out what you care about.",
        ],
      },
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
      {
        heading: "Your prompt gets expanded first",
        items: [
          "A director model rewrites what you type into a full scene description — motion, camera and sound — before the video model reads it. A single sentence is enough to start.",
          "It is shown your image too, so it can build the action around what is actually in frame.",
        ],
      },
      PROMPT_STRUCTURE,
      { heading: "Length", items: [DURATION_NOTE] },
    ],
  },

  "minimax-h3-ref": {
    sections: [
      {
        heading: "Your prompt gets expanded first",
        items: [
          "A director model rewrites what you type into a full scene description — shots, performance, camera and sound — before the video model reads it. A single sentence is enough to start.",
          "It is shown your reference images too, so it can build the scene around what is actually in them.",
          "<Picture 1> and <Picture 2> tags are carried through the rewrite untouched, so keep using them.",
        ],
      },
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

  "minimax-h3-ref2v": {
    sections: [
      {
        heading: "Working from a clip",
        items: [
          "Two ways in. Press Remix on a finished generation and the clip arrives with the prompt it was made with, or drop a video of your own into the Source panel.",
          "The clip supplies the motion, the framing and the audio. Five frames sampled evenly across it become the reference images, so the model has the look of the whole thing rather than just its first moment.",
          "Your own clips are held to 768×1344, 20 seconds and 4 MB — the remix is generated at the source's size and length, so an oversized clip asks the model for a canvas it was not built for. Scale it down first.",
          "The quickest way to iterate is generate, remix, change one thing.",
        ],
      },
      {
        heading: "Your prompt gets expanded first — differently here",
        items: [
          "The other workflows run a director model that fills in everything you left unsaid. This one runs a remix director instead, which does close to the opposite: it reads what you type as a change and writes out instructions to hold everything else to the source.",
          "So “make him a pirate” becomes: keep the performance, camera, cuts, environment and dialogue, change the costume. Short instructions work well — you are describing a delta, not a scene.",
          "It will not invent replacement dialogue just because someone is speaking. The clip's own audio supplies the words unless you ask for different ones.",
          "It sees the same five sampled frames the model does, and refers to the source as <Video 1> and <Audio 1>.",
        ],
      },
      {
        heading: "Size and length are not yours to set",
        items: [
          "Both are measured off the clip: its frames give the width and height, and how many of them there are gives the length. A remix comes back the same shape and the same length as what went in.",
          "So there is no aspect ratio, frame size or duration control here. Frame rate is the exception — the frame count is fixed, so changing it changes how fast those frames play, and with it how long the result runs. Leave it matching the source unless you want that.",
        ],
      },
      {
        heading: "What carries over, and what does not",
        items: [
          "The prompt and the frame rate come across from the generation you remixed, since the clip cannot supply either. Change them before running.",
          "The seed does not carry over. Reusing it would pin the new take to the old one's noise, which is the opposite of what a remix is for.",
          "Steps start lower here than on the other workflows. A remix is holding to a source rather than inventing from noise, so it needs fewer.",
        ],
      },
      PROMPT_STRUCTURE,
    ],
  },
};

export function tipsFor(workflowId: string): WorkflowTips | undefined {
  return WORKFLOW_TIPS[workflowId];
}
