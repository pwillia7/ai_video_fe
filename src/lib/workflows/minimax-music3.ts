import type { ComfyGraph } from "@/lib/comfy";
import { directorTarget } from "./minimax-common";
import {
  LYRICS_DIRECTOR,
  MUSIC_DIRECTOR,
  lyricSections,
  lyricsBrief,
  lyricsLength,
  musicLength,
} from "./music3-director";
import type { ParamDef, WorkflowDef } from "./types";

/**
 * MiniMax Music 3: a song from a description and, optionally, your own lyrics.
 *
 * The only workflow here that is not H3 and not video. What it shares with the
 * others is the shape: a graph verbatim from ComfyUI, a prompt the user writes
 * that an LLM expands before the model sees it, and params that drive named
 * node inputs and nothing else.
 *
 * Two inputs reach the model and they are kept strictly apart:
 *
 * - `caption` on node 37:13 is the music description, and it comes from the
 *   director at 46 rather than from the form. Music 3 reads a structured
 *   caption with fixed field names, which is not something anyone should have
 *   to type — see music3-director.ts.
 * - `lyrics` on the same node is what gets sung. By default it goes there from
 *   the form untouched: no rewrite, no expansion, no LLM anywhere near it, and
 *   the caption director is shown the section tags and nothing else.
 *
 * The "Write the lyrics for me" switch is the exception, and it adds a second
 * director rather than changing the first. Node 47 runs after 46 and *reads its
 * caption as its user message*, so the lyricist knows the genre, the singer and
 * the section-by-section arrangement it is writing into. Its output replaces
 * the lyrics box as the input to 37:13. See `finalize`, which is where the
 * switch actually does its work, and LYRICS_DIRECTOR for why the subject the
 * user types travels in the system prompt instead.
 *
 * The graph's ids come from a flattened subgraph, so most of them are "37:n"
 * with the nodes added around it numbered plainly.
 */
const PROMPT_NODE = "44";
const DIRECTOR_NODE = "46";
const LYRICIST_NODE = "47";
const ENCODE_NODE = "37:13";
const SAMPLER_NODE = "37:9";
const SEED_NODE = "37:38";

const graph: ComfyGraph = {
  "35": {
    class_type: "SaveAudioAdvanced",
    inputs: {
      filename_prefix: "audio/audio_minimax_music3",
      format: "mp3",
      // Variadic on `format`, and only meaningful while that is mp3. Left as
      // exported rather than exposed, because a format control would have to
      // change the shape of this node's inputs rather than a value in it.
      "format.quality": "V0",
      audio: ["37:43", 0],
    },
    _meta: { title: "Save Audio (Advanced)" },
  },
  "44": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "then they fly to the moon on broomsticks" },
    _meta: { title: "Input Text (Prompt)" },
  },
  "45": {
    class_type: "OAIAPI_Client",
    inputs: {
      base_url: "https://api.openai.com/v1",
      max_retries: 2,
      timeout: 600,
      api_key: "-",
    },
    _meta: { title: "OpenAI API - Client" },
  },
  "46": {
    class_type: "OAIAPI_ChatCompletion",
    inputs: {
      model: "gpt-5.6-terra",
      force_regen: false,
      prompt: ["44", 0],
      // Empty in the export — the workflow was run with the rewrite doing
      // nothing in particular. Overwritten per run by every control that
      // shapes the caption; see `director` below.
      system_prompt: "",
      client: ["45", 0],
      // No `images` input, unlike the H3 directors. There is nothing to look
      // at here, and the lyrics stay out on purpose.
    },
    _meta: { title: "OpenAI API - Chat Completion" },
  },

  // The lyricist. Not in the ComfyUI export: it is the same node class as 46
  // on the same client, so it needs nothing installed that the graph did not
  // already need.
  //
  // Its user message is the caption node's output — that is the whole trick,
  // and the reason the words come back in the right genre for the right singer
  // without anything being described twice. Deleted outright on a run where the
  // user wrote their own lyrics; see `finalize`.
  "47": {
    class_type: "OAIAPI_ChatCompletion",
    inputs: {
      model: "gpt-5.6-terra",
      force_regen: false,
      prompt: ["46", 0],
      // Written per run, like 46's: LYRICS_DIRECTOR plus what the user said
      // the song should be about.
      system_prompt: "",
      client: ["45", 0],
    },
    _meta: { title: "OpenAI API - Chat Completion (Lyrics)" },
  },

  "37:6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_music3_dit_fp16.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "37:3": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "37:7": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_music3_dav.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "37:13": {
    class_type: "MiniMaxMusic3TextEncode",
    inputs: {
      caption: ["46", 0],
      // Written by the form on every run. Empty here rather than carrying the
      // export's own lyrics, which are the *form's* default instead — see
      // DEFAULT_LYRICS, where they are useful as an example of the tag format.
      lyrics: "",
      seed: ["37:38", 0],
      max_duration: 60,
      cfg_scale: 1.7,
      top_k: 50,
      clip: ["37:3", 0],
    },
    _meta: { title: "MiniMax Music3 Text Encode" },
  },
  "37:10": {
    class_type: "ConditioningZeroOut",
    inputs: { conditioning: ["37:13", 0] },
    _meta: { title: "Conditioning Zero Out" },
  },
  // Output 1 of the encode is the length in seconds, so the latent is sized
  // from the same node the duration control writes to rather than from a
  // second copy of the number.
  "37:15": {
    class_type: "EmptyMiniMaxMusic3LatentAudio",
    inputs: { seconds: ["37:13", 1], batch_size: 1 },
    _meta: { title: "Empty MiniMax Music3 Latent Audio" },
  },
  "37:9": {
    class_type: "KSampler",
    inputs: {
      seed: ["37:38", 0],
      steps: 30,
      cfg: 1.7,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      model: ["37:6", 0],
      positive: ["37:13", 0],
      negative: ["37:10", 0],
      latent_image: ["37:15", 0],
    },
    _meta: { title: "KSampler" },
  },
  "37:12": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["37:9", 0], vae: ["37:7", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "37:38": {
    class_type: "SeedNode",
    inputs: { seed: 86571481055068 },
    _meta: { title: "Seed" },
  },
  "37:42": {
    class_type: "VAEDecodeAudioTiled",
    inputs: {
      tile_size: 1536,
      overlap: 64,
      samples: ["37:9", 0],
      vae: ["37:7", 0],
    },
    _meta: { title: "VAE Decode Audio (Tiled)" },
  },
  // Both decoders are wired and this picks between them. Left switched to the
  // tiled one as exported: it is what keeps a five-minute decode inside a
  // card's memory, and it is not a choice about the music.
  "37:43": {
    class_type: "ComfySwitchNode",
    inputs: {
      switch: true,
      on_false: ["37:12", 0],
      on_true: ["37:42", 0],
    },
    _meta: { title: "If/Else Switch" },
  },
};

/**
 * The single target every control that shapes the caption writes — the
 * description is not one of them, since that is the director's *input* rather
 * than part of its instructions. The duration and the lyrics are: one decides
 * how much song there is room for, the other what sections it has.
 *
 * `musicLength` displaces the video graphs' length block, which talks about
 * shot cuts and speakable dialogue.
 */
const director = directorTarget(
  { director: DIRECTOR_NODE },
  MUSIC_DIRECTOR,
  [lyricSections()],
  musicLength,
);

/**
 * The same idea one node along: every control that shapes the *lyrics* writes
 * node 47's system prompt in full. Only two do — the switch itself and the
 * subject box — plus the duration, which decides how many lines there is room
 * to sing.
 *
 * Written on every run, including the ones where the lyricist is deleted before
 * the graph is queued. Assembling an instruction for a node that is about to go
 * costs nothing, and the alternative is a param that writes a target only
 * sometimes, which `applyParams` would have to be taught about.
 */
const lyricist = directorTarget(
  { director: LYRICIST_NODE },
  LYRICS_DIRECTOR,
  [lyricsBrief()],
  lyricsLength,
);

/** The export's own lyrics, kept as the default so the tag format is visible. */
const DEFAULT_LYRICS = `[Intro]
Mmm...
(rain on the window)
Ooh...

[Verse]
Midnight and the canvas glows
Dragging little wires where the current flows
Type a quiet dream, let the sampler drift
Noise into a picture, like the fog just lifts

[Chorus]
Mmm... let it render on
(take your time, take your time)
Ooh... by the morning it'll all be done
(one more queue, one more try)

[Instrumental]

[Outro]
Mmm...
(node to node)
Ooh... goodnight`;

const params: ParamDef[] = [
  {
    id: "prompt",
    label: "Describe the music",
    type: "textarea",
    rows: 5,
    default:
      "A slow lo-fi bedroom pop song about staying up late, soft female vocal, rain outside.",
    placeholder: "Genre, mood, the voice, what it should sound like.",
    maxLength: 2000,
    help: "One line is enough. A director expands it into the model's caption format.",
    group: "Song",
    targets: [{ node: PROMPT_NODE, input: "value" }],
  },
  {
    id: "write_lyrics",
    label: "Write the lyrics for me",
    type: "toggle",
    default: false,
    help: "A second director writes them from the caption, so they match the style.",
    group: "Song",
    // It shapes both instructions: the caption director stops describing a
    // lyric sheet that does not exist yet, and the lyricist is what it turns
    // on. The graph rewiring itself is `finalize`'s job, not a target's.
    targets: [director, lyricist],
  },
  {
    id: "lyrics_about",
    label: "What the song is about",
    type: "textarea",
    rows: 4,
    default: "",
    placeholder: "A subject, a story, a person, a line you want in it.",
    maxLength: 2000,
    help: "Optional. Left empty, the lyricist takes its subject from the music.",
    group: "Song",
    revealedBy: "write_lyrics",
    targets: [lyricist],
  },
  {
    id: "lyrics",
    label: "Lyrics",
    type: "textarea",
    rows: 14,
    default: DEFAULT_LYRICS,
    placeholder: "[Verse]\nyour words here",
    maxLength: 6000,
    help: "Sung exactly as written — no rewrite. Tag sections as [Verse], [Chorus], [Instrumental]. Leave empty for an instrumental.",
    group: "Song",
    // Kept out of the form while the lyricist is on rather than disabled in
    // place: what someone typed is still here and comes back with the switch,
    // but a box whose contents are being ignored invites the belief that they
    // are not.
    hiddenBy: "write_lyrics",
    targets: [
      // Trimmed on the way in, so that a box holding only whitespace is the
      // same instrumental to the model as an empty one — which is what the
      // director is told it is.
      {
        node: ENCODE_NODE,
        input: "lyrics",
        transform: (value) => String(value).trim(),
      },
      // Also shapes the caption, but only through its section tags — see
      // lyricSections. The words themselves reach the model and no one else.
      director,
    ],
  },

  {
    id: "duration",
    label: "Length",
    type: "slider",
    default: 60,
    min: 15,
    // Music 3 generates up to five minutes. Past that it is not a setting
    // this app is declining to offer, it is outside the model.
    max: 300,
    step: 5,
    unit: "s",
    help: "The model's own ceiling is five minutes. Longer takes longer.",
    group: "Output",
    targets: [{ node: ENCODE_NODE, input: "max_duration" }, director],
  },

  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    help: "Reuse one to get the same take again.",
    group: "Sampling",
    // One node feeds both the sampler and the text encode, so there is a
    // single seed here rather than two that could drift apart.
    targets: [{ node: SEED_NODE, input: "seed" }],
  },
  {
    id: "steps",
    label: "Steps",
    type: "slider",
    default: 30,
    min: 8,
    max: 60,
    step: 1,
    group: "Sampling",
    targets: [{ node: SAMPLER_NODE, input: "steps" }],
  },
  {
    id: "guidance",
    label: "Guidance",
    type: "slider",
    default: 1.7,
    min: 1,
    max: 5,
    step: 0.1,
    help: "How closely the take follows the caption. Higher is more literal and less musical.",
    group: "Sampling",
    advanced: true,
    // Two inputs, one control. The export carries 1.7 in both places, and they
    // are the same quantity read at two stages — letting the form move one
    // without the other would be offering a setting that means nothing.
    targets: [
      { node: SAMPLER_NODE, input: "cfg" },
      { node: ENCODE_NODE, input: "cfg_scale" },
    ],
  },
  {
    id: "top_k",
    label: "Top-k",
    type: "number",
    default: 50,
    min: 1,
    max: 200,
    step: 1,
    help: "How wide the model's choice is at each step. Lower is safer and more repetitive.",
    group: "Sampling",
    advanced: true,
    targets: [{ node: ENCODE_NODE, input: "top_k" }],
  },
];

export const minimaxMusic3: WorkflowDef = {
  id: "minimax-music3",
  name: "Music",
  description: "Writes a song from a description, singing lyrics you supply.",
  // Scaled from the default 60-second track at 30 steps; the client replaces
  // it with this machine's median as soon as one run has finished.
  estimatedSeconds: 180,
  hasAudio: true,
  makes: "music",
  graph,
  params,
  /**
   * No turbo and no patches. The LoRA and the Spectrum node are both H3's —
   * they name that model — and SageAttention would splice onto this UNET but
   * has never been run against it here, so it is not offered rather than
   * offered untested.
   */

  /**
   * Which of the two lyric sources is actually wired up.
   *
   * A param cannot do this: `lyrics` on the encode node is either a string the
   * form wrote or a link to node 47, and swapping a value for a link is a
   * change to the graph rather than to a value in it.
   *
   * Off is the default and deletes the lyricist outright. Leaving it in place
   * unused would still run it — ComfyUI executes every node an output depends
   * on, and nothing else would be reading this one, but a node with no consumer
   * is a node someone will later wire up by accident. It also spends an API
   * call per run on words nobody asked for.
   */
  finalize(graph, values) {
    if (values.write_lyrics === true) {
      graph[ENCODE_NODE].inputs.lyrics = [LYRICIST_NODE, 0];
      return;
    }
    delete graph[LYRICIST_NODE];
  },
};
