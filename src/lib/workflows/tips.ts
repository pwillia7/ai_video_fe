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
          "The reference video supplies motion, framing and audio. Your prompt says what should be different about the new take.",
          "Remix on a finished generation loads it here, along with the prompt and framing it was made with — so the quickest way to iterate is generate, remix, change one thing.",
          "A clip from anywhere works too, not only your own generations, as long as it is under the 4 MB upload limit.",
        ],
      },
      {
        heading: "Your prompt gets expanded first — differently here",
        items: [
          "The other workflows run a director model that fills in everything you left unsaid. This one runs a remix director instead, which does close to the opposite: it reads what you type as a change and writes out instructions to hold everything else to the source.",
          "So “make him a pirate” becomes: keep the performance, camera, cuts, environment and dialogue, change the costume. Short instructions work well; you are describing a delta, not a scene.",
          "It will not invent replacement dialogue just because someone is speaking — the clip's own audio supplies the words unless you ask for different ones.",
          "It is shown your reference images, but not the clip. It refers to the source as <Video 1> and <Audio 1> rather than describing contents it cannot see.",
          "<Picture 1> and <Picture 2> tags are carried through the rewrite untouched, so keep using them.",
        ],
      },
      {
        heading: "Adding reference images",
        items: [
          "Optional here — the clip on its own is enough. Add one to bring in a subject the video does not already contain.",
          "Name each by tag in the order you added it: <Picture 1> for the first, <Picture 2> for the second.",
          "Say what each reference controls — identity, style, motion, camera, voice. Spelling this out works much better than leaving it implied.",
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
