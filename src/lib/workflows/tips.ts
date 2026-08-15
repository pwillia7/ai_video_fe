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
  /**
   * Where this advice comes from, when it is not ComfyUI's H3 guide — which is
   * what the modal credits by default and what every video workflow here is
   * drawn from. The music workflow is a different model with a different
   * source, and crediting the H3 tutorial for it would be a false citation.
   */
  source?: { href: string; label: string };
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

/**
 * The bypass switch, said once and shown wherever the rewrite is described —
 * it is the one control that turns off everything the section above it says.
 */
const LITERAL_NOTE =
  "Send my prompt as written turns all of that off: the model gets your text exactly as typed, and no LLM node runs at all. It expects the model's own format, so it is for a prompt you have written by hand rather than a line to be expanded.";

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
    "<Picture 1>, <Picture 2> and the rest survive the rewrite — it turns them into the labelled subject definitions the model expects, so keep using them.",
    LITERAL_NOTE,
  ],
};

const REFERENCE_IMAGES: TipSection = {
  heading: "Referring to your images",
  items: [
    "Name each reference by tag, in the order you uploaded it: <Picture 1> for the first, <Picture 2> for the second, and so on.",
    "What to keep decides what an image is actually for. Everything holds the face, the build, the outfit and the way it is drawn. Identity only holds the person and lets your prompt dress them. Costume and gear only moves the outfit onto whoever the scene casts. Style only takes the look and leaves the subject behind.",
    "It is worth setting deliberately. The model is told which of those it is, and which of its four preservation markers the image takes — left to infer, that is the one part of the format it has no evidence for.",
    "Your prompt still governs the detail. The setting says whether the coat is preserved at all; the prompt says which coat, and wins outright if the two disagree.",
    "Proportions and drawing style are the two things that slip without being asked to. A stylised character drifts toward ordinary human build and a drawn one toward photographic, so both are named explicitly whenever an image is set to keep them.",
    "Reference handling: match is faster, max preserves identity better at up to a 2048px short edge.",
    "The model accepts up to 9 reference images. This workflow wires four, and offers each one only once the one before it has an image — so it opens as a single upload and grows as you use it.",
  ],
};

const REFERENCE_TRACK: TipSection = {
  heading: "Building a video around a track",
  items: [
    "A piece of music can be a reference too. Press Create video on a finished track and it arrives in the Reference track slot here, ready to generate.",
    "It goes to the model as a reference audio, alongside whatever pictures you attach — the two are separate references and neither replaces the other. A track and no picture is allowed; so is a picture and no track. One of the two is required, and with no picture everything on screen comes from your prompt.",
    "A loaded track pins Steps to 4. That is the step count this workflow takes a track at: at 4 it loads the bf16 diffusion model and text encoder, which is the pair that accepts a track and pictures together, and leaves Spectrum out. Remove the track and the control is yours again. Leave Turbo on — four steps without the distilled LoRA is not a usable take.",
    "The video is still the length of the Duration control. A four-minute song attached to a five-second clip is a reference to five seconds of music, not an instruction to make a four-minute video — nothing here can generate one.",
    "So only the opening of the track is sent, as many seconds of it as the video is long. How much of the track changes that: a set length if you want a fixed number of seconds, all of it if you really want the whole file. MiniMax documents a reference track at 2–15 seconds, and a three-minute one is thousands of latent frames of sequence for a five-second video.",
    "It is always the start of the track. Which fifteen seconds of a song you get is not a choice yet, so if the opening is an intro that sounds like nothing else on the record, trim the track before you generate it rather than after.",
    "The soundtrack that comes back is the model's own. The attached track steers it rather than being copied into the output, so treat it as a brief for the score and not as the score.",
    "The director is told a track is attached and stops writing a score of its own. Without that it invents one, and the model is then asked for a second piece of music over the one it was handed.",
    "It cannot hear the track — the director is shown pictures and nothing else — so if you want the action timed to the music, say so in the prompt. Anything on the beat has to come from you.",
    "Uploading a track by hand is capped at 4 MB, which a few minutes of mp3 will exceed. The button has no such limit: it copies the file between ComfyUI's own directories and never sends it through the browser.",
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
          LITERAL_NOTE,
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
          LITERAL_NOTE,
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
      REFERENCE_TRACK,
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
          LITERAL_NOTE,
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
          LITERAL_NOTE,
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

  "minimax-music3": {
    source: {
      href: "https://github.com/MiniMax-AI/MiniMax-Music3#prompt-enhancement",
      label: "From MiniMax's Music 3 prompt guide ↗",
    },
    sections: [
      {
        heading: "Two inputs that never mix",
        items: [
          "Describe the music says what the record sounds like. Lyrics are the words that get sung. They travel separately and neither becomes the other.",
          "The description is rewritten by default. A director expands it into the structured caption Music 3 was trained on — three fixed sections covering the metadata, the voice and the arrangement — so a line about the genre, the mood and the singer is enough to write.",
          "Send my description as written turns that off, and what is in the box becomes the caption itself. Worth it only if you are writing those three sections yourself — the model reads a caption, not a wish.",
          "Lyrics you type are never rewritten, summarised or paraphrased. They reach the model exactly as typed. The switch below is the only thing that writes words for you, and it replaces the box rather than editing it.",
        ],
      },
      {
        heading: "What to do with a finished track",
        items: [
          "Create video sends it to Reference to Video as a reference track, the same way Remix and Extend send a clip. The picture is then yours to supply — a reference image, a prompt, or both — and that run is pinned to 4 steps, which is where the track works.",
          "The whole song goes across, but only the first few seconds of it reach the model: as much as the video is long, unless you say otherwise there. A song is a reference for those seconds rather than a length to fill.",
          "The video is as long as that workflow's own Duration control, which tops out at 20 seconds. A finished song is a reference for those seconds rather than a length to fill.",
          "The file never goes through your browser: it is copied between ComfyUI's own directories, so the upload size limit does not apply to it.",
        ],
      },
      {
        heading: "Or let it write the lyrics",
        items: [
          "Write the lyrics for me turns on a second director that writes the words instead of you, and the lyrics box stands down while it is on. What you typed there is kept and comes back when you switch it off.",
          "It is handed the finished caption as its brief, so it already knows the genre, the tempo, the singer and the section-by-section arrangement. You do not need to describe the music again.",
          "What the song is about is the only thing it cannot get from the music. A subject, a situation, a person, a line you want in it — as much or as little as you like. Left empty, it takes its subject from the mood and imagery in the caption.",
          "With the switch on, the song's structure is decided by the caption rather than by a lyric sheet: the music director lays out the sections and the lyricist writes into them.",
          "It writes to the running time — roughly how many lines fit, counted against the seconds — so a short track gets a short lyric rather than one crammed in, and a long one gets enough words to last.",
        ],
      },
      {
        heading: "Writing lyrics yourself",
        items: [
          "Tag the sections in square brackets on their own lines: [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Instrumental], [Solo], [Outro].",
          "Those tags are the one part of the lyrics the director is shown — as a list of section names, never the words — so the arrangement it writes develops where your song actually changes.",
          "A tag can carry an instruction of its own, like [Chorus - double time], and that reaches the arrangement for that section only.",
          "Leave the box empty for an instrumental. The caption director is told to write the piece around a lead instrument, to fill Vocal Details with an explicit refusal rather than a description, and to keep a voice out of every other field — and unless you turn Plan the sections off, a wordless section plan goes into the lyrics field so the piece has a shape to play to.",
          "If your description asks for a vocal — the starting description does, and it is easy to leave in — an empty lyrics box now overrides it rather than trying to honour both. That combination is the usual reason an instrumental comes back sung: a caption that names a singer gets one, and a singer with no words invents them.",
        ],
      },
      {
        heading: "Length is a target, not a dial",
        items: [
          "The slider sets what the song is written to fill. Nothing in this model takes a length as a number, so that target reaches it only as structure — the caption, the lyric sheet and the section plan are all written to add up to it. The model plays the song it was given and then stops, so a take can still come back shorter: that is the model deciding the song is over, not a setting being ignored.",
          "The run is cut off a little past the target — about fifteen per cent — rather than exactly on it. That headroom is deliberate: a song that lands right on the number needs somewhere to put its last bar, and a cut-off sitting on the target would take the ending off the takes that went well. It costs nothing when it goes unused.",
          "What the caption can do about it is describe more song. The director is told the target and asked to spend it structurally — a list of sections in order, each with a size in bars or repeats or seconds, that takes that long to play.",
          "What it deliberately does not do is announce the duration. MiniMax's own caption templates carry BPM, key, genre and an arrangement, and never a running time, so a line saying the piece lasts 3:40 is text the model was not trained to act on. Writing the length into your own description has the same problem — the slider is the place for it.",
          "You do not need to type the length into the description yourself. The slider is passed through and governs — a length written in your own words is deliberately not repeated, so the two cannot disagree.",
          "Instrumentals come back shortest, because the lyrics field — which is the model's structural channel, not only its words — is empty. Plan the sections fills it instead, with a wordless plan of bracketed tags: [Intro - 12 seconds], [Theme - 40 seconds], [Solo - 35 seconds], [Outro - 15 seconds], adding up to the length you asked for.",
          "That plan is written from the caption, by a second pass that reads it. So the sections in it are the ones the caption actually described, at the lengths it gave them — a forty-second solo stays a forty-second solo in both places, instead of the plan being a row of identical blocks the caption is asked to fit.",
          "Everything that lands in the lyrics field is performed, so that pass is filtered on the way out: any line it writes that is not a bracketed tag is deleted before the model sees it. A plan is nothing but tags, which is what makes the filter safe here — it is not applied to lyrics, where the unbracketed lines are the song.",
          "Turn it off under the Lyrics box to send nothing and let the model decide where to stop, which is what it did before.",
          "The caption steers instrumentals toward the devices that make instrumental music long — a restated theme, a solo with a length of its own, a breakdown, a reprise — and away from an evolving texture, which has no reason to run any particular length.",
          "If takes keep landing short, or at wildly different lengths, the control that acts on it directly is Top-k under Advanced. The end-of-song token is an ordinary candidate in the same draw as the audio itself, so it can only be picked on a frame where it ranks inside Top-k. Narrowing that field removes the chance outright instead of leaving it small.",
          "Small chances are the problem: at 25 frames a second a four-minute track is 6000 draws, so even a tiny per-frame chance of stopping ends most takes early. Try Top-k 20, then 12 if it is still short. Below about 10 the music itself starts to flatten.",
          "Guidance does the same job by persuasion rather than by exclusion — higher takes the caption more literally, including where it says the song ends. 2.0 to 2.5 is worth trying alongside a lower Top-k.",
          "Length is decided by the draw, so it is decided by the seed. When a take comes back the length you wanted, Reuse seed keeps it while you change other things.",
          "The slider stops at five minutes, which is what MiniMax's model card claims for the model. ComfyUI's own limit for the node is six — 9000 acoustic frames at 25 a second — and the difference is what the cut-off has to sit in.",
          "Longer is slower, roughly in proportion. The estimate on the progress bar learns this machine's real pace after the first finished run.",
        ],
      },
      {
        heading: "The other controls",
        items: [
          "Steps behave as everywhere else: fewer for a quick idea, more for the take you keep.",
          "Caption guidance and Top-k are worth reaching for rather than leaving alone, because between them they decide how consistent a run is — see the length section above.",
          "Caption guidance is how literally the song follows the caption. At 1.7 it interprets; pushed to 2.0–2.5 it obeys, which holds both the style and the ending. Past about 3 the music stiffens and starts sounding like a description being executed.",
          "Top-k is how many candidates the model may choose between each frame. 50 is the model's own default and the most varied; lower narrows it, which makes takes more consistent in length and more repetitive in content.",
          "Sampler CFG is a different thing and is the one to leave alone. The model generates in two stages — one writes the song as tokens, the other renders those tokens into audio — and this guides the second. It changes how the take sounds, never how long it is or what happens in it. Both stages ship at 1.7, which is the only reason they look like the same setting.",
          "Turbo, SageAttention and Spectrum are not offered here. Turbo's LoRA and the Spectrum node are built for H3, and this is a different model; SageAttention probably would splice on, but it has not been run against this graph.",
        ],
      },
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
    "At exactly 4, the graph swaps in the pack's dedicated 4-step sampler in place of the usual one. Nothing to turn on: the steps control decides it, and the note under that control says so while it is in effect. It comes from the same pack as the LoRA.",
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
      "Reference to Video refuses it at 4 steps, and shows the switch as off there. That graph's four-step form is the pack's own — distilled sampler, bf16 weights, no forecaster — and a reference track pins the run to 4, so a track means no Spectrum. The switch keeps its setting and comes back the moment the step count does.",
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
