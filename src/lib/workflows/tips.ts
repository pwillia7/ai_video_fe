/**
 * Prompting guidance for the MiniMax H3 workflows, from ComfyUI's tutorial:
 * https://docs.comfy.org/tutorials/video/minimax/minimax-h3
 *
 * Kept as data rather than prose in the UI so each workflow can show only what
 * applies to it — the reference workflow in particular has advice that would be
 * meaningless on the others.
 */

import type { RunModes } from "./modes";

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
    "You do not have to write any of this in the model's own format — the director does that for you, laying the result out as timed shots, tagged dialogue and separate soundscape and score fields.",
  ],
};

const DURATION_NOTE =
  "Duration snaps to the model's 17-frame grid (17k+5) at 24fps, so a clip can land slightly longer than you asked for.";

const LENGTH_NOTE =
  "The director is told how long the clip will be, and writes to it — so the shot timings fit and the dialogue is short enough to actually be spoken in the time available.";

const RANGE_NOTE =
  "The model is trained to about 15 seconds. The slider goes to 20, but past 15 you are outside what it was built for.";

/**
 * Shared by both reference workflows. They run the same graph and the same
 * director; the turbo one only changes how many steps the sampler takes, so
 * everything about prompting and references reads identically on both.
 */
const REFERENCE_REWRITE: TipSection = {
  heading: "Your prompt gets expanded first",
  items: [
    "A director model rewrites what you type into a full scene description — shots, performance, camera and sound — before the video model reads it. A single sentence is enough to start.",
    "It is shown your reference images too, so it can build the scene around what is actually in them.",
    "<Picture 1> and <Picture 2> tags survive the rewrite — it turns them into the labelled subject definitions the model expects, so keep using them.",
  ],
};

const REFERENCE_IMAGES: TipSection = {
  heading: "Referring to your images",
  items: [
    "Name each reference by tag, in the order you uploaded it: <Picture 1> for the first, <Picture 2> for the second.",
    "What to keep decides what an image is actually for. Everything holds the face, the build, the outfit and the way it is drawn. Identity only holds the person and lets your prompt dress them. Costume and gear only moves the outfit onto whoever the scene casts. Style only takes the look and leaves the subject behind.",
    "It is worth setting deliberately. The model is told which of those it is, and which of its four preservation markers the image takes — left to infer, that is the one part of the format it has no evidence for.",
    "Your prompt still governs the detail. The setting says whether the coat is preserved at all; the prompt says which coat, and wins outright if the two disagree.",
    "Proportions and drawing style are the two things that slip without being asked to. A stylised character drifts toward ordinary human build and a drawn one toward photographic, so both are named explicitly whenever an image is set to keep them.",
    "Reference handling: match is faster, max preserves identity better at up to a 2048px short edge.",
    "The model accepts up to 9 reference images. This workflow wires two.",
  ],
};

const REFERENCE_LENGTH: TipSection = {
  heading: "Length",
  items: [DURATION_NOTE, LENGTH_NOTE, RANGE_NOTE],
};

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
          LENGTH_NOTE,
          RANGE_NOTE,
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
      { heading: "Length", items: [DURATION_NOTE, LENGTH_NOTE, RANGE_NOTE] },
    ],
  },

  "minimax-h3-ref": {
    sections: [
      REFERENCE_REWRITE,
      REFERENCE_IMAGES,
      PROMPT_STRUCTURE,
      REFERENCE_LENGTH,
    ],
  },

  "minimax-h3-ref2v": {
    sections: [
      {
        heading: "Working from a clip",
        items: [
          "Two ways in. Press Remix on a finished generation and the clip arrives with the prompt it was made with, or drop a video of your own into the Source panel.",
          "The clip is the only reference the model gets — it supplies the motion, the framing and the audio all at once, as one thing rather than as a pile of stills.",
          "Your own clips are held to 768×1344, 20 seconds and 4 MB — the remix is generated at the source's size and length, so an oversized clip asks the model for a canvas it was not built for. Scale it down first.",
          "The quickest way to iterate is generate, remix, change one thing.",
        ],
      },
      {
        heading: "Your prompt gets expanded first — differently here",
        items: [
          "The other workflows run a director model that fills in everything you left unsaid. This one runs a remix director instead, which does close to the opposite: it reads what you type as a change and writes out instructions to hold everything else to the source.",
          "So “make him a pirate” becomes: keep the performance, camera, cuts, environment and dialogue, change the costume. Short instructions work well — you are describing a delta, not a scene.",
          "How much changes follows how much you ask for. A costume note touches the costume; “turn this into claymation” or “set this underwater” is licensed to re-render nearly everything while the performance, staging and timing survive. Ask small for small.",
          "Sound moves with the world. Change the weather, the room or the medium and the soundtrack follows — but the words spoken, the voices speaking them and the music stay put unless you say otherwise.",
          "It will not invent replacement dialogue just because someone is speaking. The clip's own audio supplies the words unless you ask for different ones.",
          "It is shown five frames sampled evenly across the clip, so it can write about what is actually there. Those frames are for the director only — the model itself works from the clip — and it refers to the source as <Video 1> and <Audio 1>.",
        ],
      },
      {
        heading: "Size and length are not yours to set",
        items: [
          "Both are measured off the clip: its frames give the width and height, and how many of them there are gives the length. A remix comes back the same shape and the same length as what went in.",
          "So there is no aspect ratio, frame size or duration control here, and no frame rate either — that is fixed at the 24fps the model works in, on every workflow.",
        ],
      },
      {
        heading: "What carries over, and what does not",
        items: [
          "The prompt comes across from the generation you remixed — the one thing the clip cannot supply. Change it before running.",
          "The seed does not carry over. Reusing it would pin the new take to the old one's noise, which is the opposite of what a remix is for.",
          "Steps start lower here than on the other workflows. A remix is holding to a source rather than inventing from noise, so it needs fewer.",
        ],
      },
      PROMPT_STRUCTURE,
    ],
  },

  "minimax-h3-extend": {
    sections: [
      {
        heading: "Working from a clip",
        items: [
          "Two ways in. Press Extend on a finished generation and the clip arrives ready to continue, or drop a video of your own into the Source panel.",
          "Only the clip's last frame reaches the model. It is the first frame of the new footage, and its size is the size everything is generated at — so the same 768×1344 ceiling applies as everywhere else.",
          "What comes back is the source clip with the new footage joined onto the end, picture and sound. So an extension can be extended again, and again, without ever reassembling anything by hand.",
        ],
      },
      {
        heading: "Duration is the part that is added",
        items: [
          "The duration control times the new footage, not the file that comes back. Ask for 5 seconds on a 10-second clip and 15 seconds arrive.",
          "Only the new segment is generated, so a run costs about what a fresh generation of that length costs however long the source has become.",
          DURATION_NOTE,
        ],
      },
      {
        heading: "Your prompt gets expanded first — differently here",
        items: [
          "This one runs a continuation director. It reads what you type as what happens next, and spends most of its effort on the seam: no establishing shot, no reset to a neutral pose, no cut, and motion already underway carried through.",
          "So write the next beat, not the scene. “Then he opens the door” is a complete instruction — identity, wardrobe, lighting, camera and location all carry over from the last frame without being asked for.",
          "It will not replay the source's dialogue, and it only writes new lines when your continuation calls for speech.",
          "Everything it knows about the source is that one frame. If something important happened earlier in the clip and matters to what comes next, say so.",
        ],
      },
      {
        heading: "What carries over, and what does not",
        items: [
          "The prompt does not come across, unlike Remix. The text that made the source describes the source, and asking a continuation director to continue with it would have the clip do again what it just did.",
          "The seed does not carry over either — the new segment is generated from noise like any other.",
        ],
      },
      PROMPT_STRUCTURE,
    ],
  },
};

/**
 * Prepended to whichever workflow is on screen when the Turbo switch is on.
 * One section rather than a copy of each workflow's advice, because the LoRA
 * changes the step count and nothing else a user types.
 */
const TURBO: TipSection = {
  heading: "Turbo is on",
  items: [
    "A distilled LoRA is applied to the diffusion model, so the sampler converges in a handful of steps instead of a dozen or more. Everything else — the prompt director, the length maths, the frame you start from — behaves exactly as it does with the switch off.",
    "Remix does not offer it. It runs the reference model at 8 steps already, so the LoRA would cost quality and save no time there.",
    "On Reference to Video, compare a turbo take against a standard one before trusting it for a likeness. The LoRA's author does not officially support the reference model yet, and identity is the first thing to suffer if it drifts.",
    "Steps stop at 8 here rather than 60. Past that the LoRA is being asked for something it was not distilled to do, and the extra time buys nothing.",
    "4 is the fastest useful setting — good for iterating on a prompt. Come back up to 8 for the take you intend to keep.",
    "This is the one thing in the app that needs a node pack and a model file the base workflows do not. If every run fails with the switch on and succeeds with it off, that is what to check.",
    "Low VRAM, under the switch, applies the LoRA the memory-sparing way the pack offers. It is slower and changes nothing about the video, so leave it off unless a turbo run dies out of memory. It stays where you set it for every workflow, since it is your card it is about.",
  ],
};

/**
 * Prepended when the matching switch is on, on the same terms as TURBO and for
 * the same reason: each changes how the run is made rather than what any
 * control means, so one section per switch serves every workflow.
 *
 * Keyed by patch id, and in the order the switches stack.
 */
const PATCHES: Record<string, TipSection> = {
  sage: {
    heading: "SageAttention is on",
    items: [
      "Attention runs on SageAttention's quantised kernels instead of the default. It is a different implementation of the same operation, so nothing a user types behaves differently — but it is an approximation, and a take can come out slightly different from the same seed without it.",
      "It needs two things, not one: KJNodes for the node, and the `sageattention` package installed in ComfyUI's own Python environment for the kernels. `pnpm check:nodes` can see the node but not the package, so a run that fails with the switch on and a node the checker calls present means the package is what is missing.",
      "`auto` picks the best kernel the card actually supports, which is why nothing here asks you to choose one.",
      "The first run of a session is slower than the ones after it — the node compiles on the way through. Judge what it saves on the second take, not the first.",
    ],
  },
  spectrum: {
    heading: "Spectrum is on",
    items: [
      "The sampler runs through the Spectrum node, which forecasts steps from the ones already taken rather than computing every one in full. As with the others, the prompt director, the length maths and the frame you start from are all unchanged.",
      "It stacks with Turbo. The two do different things — Turbo changes how many steps are needed, Spectrum changes how a step is arrived at — and with both on the forecaster sits in front of the distilled model.",
      "It is offered on every workflow, Remix included. Remix skips Turbo because it already samples at 8 steps, which is no argument here.",
      "Like Turbo, this needs a node pack the base workflows do not. If every run fails with the switch on and succeeds with it off, that is what to check — `pnpm check:nodes` names the pack.",
      "Forecast steps are approximations of computed ones. If a take comes out mushier than the same seed without it, that is the trade showing, and the switch is where to look first.",
    ],
  },
};

export function tipsFor(
  workflowId: string,
  modes: RunModes = {},
): WorkflowTips | undefined {
  const tips = WORKFLOW_TIPS[workflowId];
  if (!tips) return undefined;

  // Turbo first, then the patches in chain order, matching the order the
  // switches sit in down the panel.
  const extra = [
    ...(modes.turbo ? [TURBO] : []),
    ...Object.entries(PATCHES)
      .filter(([id]) => modes.patches?.includes(id))
      .map(([, section]) => section),
  ];
  if (extra.length === 0) return tips;

  return { ...tips, sections: [...extra, ...tips.sections] };
}
