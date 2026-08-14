import type { ComfyGraph } from "@/lib/comfy";
import { directorTarget } from "./minimax-common";
import {
  MUSIC_DIRECTOR,
  ceilingSeconds,
  lyricSections,
  lyricistPrompt,
  musicConstraints,
} from "./music3-director";
import type { ParamDef, ParamTarget, WorkflowDef } from "./types";

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
 * - `lyrics` on the same node is what gets *performed*, which is the thing to
 *   keep in mind about it. By default it goes there from the form untouched:
 *   no rewrite, no expansion, no LLM anywhere near it, and the caption director
 *   is shown the section tags and nothing else.
 *
 * Two things can stand in for a typed lyric sheet, and both are node 47 — the
 * same second chat completion, told to do a different job:
 *
 * - "Write the lyrics for me" adds a second director rather than changing the
 *   first. Node 47 runs after 46 and *reads its caption as its user message*,
 *   so the lyricist knows the genre, the singer and the arrangement it is
 *   writing into, and its output replaces the box as the input to 37:13. See
 *   `finalize`, and LYRICS_DIRECTOR for why the subject travels in the system
 *   prompt instead.
 * - An empty box with "Plan the sections" on gets a timed section list from
 *   the same node, transcribed out of the caption's own arrangement, and
 *   filtered on the way through node 48 because that field is performed. See
 *   SECTION_PLANNER.
 *
 * The graph's ids come from a flattened subgraph, so most of them are "37:n"
 * with the nodes added around it numbered plainly.
 */
const PROMPT_NODE = "44";
const DIRECTOR_NODE = "46";
const LYRICIST_NODE = "47";
const PLAN_GUARD_NODE = "48";
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
  // and the reason what it writes comes back in the right genre for the right
  // singer without anything being described twice.
  //
  // Only ever writes words, and only when the lyricist is switched on.
  // Deleted outright on every other run; see `finalize`.
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

  // The guard on the section plan, and the reason an LLM is allowed to write a
  // field whose contents are performed.
  //
  // It deletes every line that does not open with a bracket. A plan is nothing
  // but bracketed tags, so what survives is the plan and what does not is the
  // "Here is the plan:" that would otherwise be sung — a whole class of failure
  // removed by a filter that cannot be wrong about which lines are which.
  //
  // Only ever on the plan path. The same filter on the lyricist's output would
  // delete the lyrics, which are precisely the lines with no bracket on them,
  // so `finalize` wires this in on one path and deletes it on the others.
  //
  // `RegexReplace` is a ComfyUI built-in (comfy_extras/nodes_string.py), so
  // this needs no pack the graph did not already need. It is in the stored
  // graph rather than spliced in by `finalize` so that `pnpm check:nodes` asks
  // a real ComfyUI whether the class is there.
  //
  // Python's `re.sub` with MULTILINE: `^(?![ \t]*\[).*$` is a line that does
  // not start with a bracket, and the trailing `\n?` takes the line break with
  // it so a stripped line leaves no blank one behind.
  //
  // The lookahead spells out space and tab rather than saying `\s`, because
  // `\s` matches a newline too — so on a blank line it would reach across the
  // break, find the bracket opening the *next* line, and keep the blank one.
  "48": {
    class_type: "RegexReplace",
    inputs: {
      string: ["47", 0],
      regex_pattern: "^(?![ \\t]*\\[).*$\\n?",
      replace: "",
      case_insensitive: true,
      multiline: true,
      dotall: false,
      count: 0,
    },
    _meta: { title: "Regex Replace (Section Plan Guard)" },
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
 * `musicConstraints` displaces the video graphs' length block, which talks
 * about shot cuts and speakable dialogue. It lands last, which is where the
 * user's own requirements belong: the director is told to rank them above
 * everything it worked out for itself.
 */
const director = directorTarget(
  { director: DIRECTOR_NODE },
  MUSIC_DIRECTOR,
  [lyricSections()],
  musicConstraints,
);

/**
 * The same idea one node along: every control that shapes what goes into the
 * lyrics field writes node 47's system prompt in full — the lyricist switch,
 * the subject box, the section-plan switch, and the duration.
 *
 * Its own builder rather than `directorTarget`, because node 47 has two jobs
 * and the run decides which: writing words when the lyricist is on, and writing
 * the timed section plan when nothing else is supplying the structural channel.
 * See lyricistPrompt.
 *
 * Written on every run, including the ones where node 47 is deleted before the
 * graph is queued. Assembling an instruction for a node that is about to go
 * costs nothing, and the alternative is a param that writes a target only
 * sometimes, which `applyParams` would have to be taught about.
 */
const lyricist: ParamTarget = {
  node: LYRICIST_NODE,
  input: "system_prompt",
  transform: (_value, values) => lyricistPrompt(values),
};

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
      //
      // An empty box writes an empty string, and `finalize` may then replace
      // that write with a link: to the lyricist, or to the section plan coming
      // through the guard. Both of those are graph edits rather than values,
      // which is why neither can happen here.
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
    id: "plan_sections",
    label: "Plan the sections",
    type: "toggle",
    default: true,
    help: "Turns the caption's arrangement into a timed section list for the piece to play to. Off sends nothing, and the model decides where to stop.",
    group: "Song",
    // Only in the case it is about to fix: no typed lyrics, no lyricist. Either
    // of those is already supplying the structural channel this fills.
    hiddenBy: ["lyrics", "write_lyrics"],
    // Both instructions, because the plan is written between them: the caption
    // director is told its arrangement will be transcribed, and node 47 is told
    // to do the transcribing. Wiring 47 into the graph at all is `finalize`'s
    // job, as it is for the lyricist.
    targets: [director, lyricist],
  },

  {
    id: "duration",
    label: "Length",
    type: "slider",
    default: 60,
    min: 15,
    /**
     * 300s, which is MiniMax's own "up to five minutes" rather than the node's
     * limit. The limit is 360 — the encode node caps `max_duration` at
     * MAX_AUDIO_FRAMES / AUDIO_FRAMES_PER_SECOND, 9000 / 25 in
     * comfy/ldm/minimax_music/ar.py — and stopping the target short of it is
     * what leaves room for the ceiling to sit above the target at every setting
     * this control can reach. See ceilingSeconds.
     */
    max: 300,
    step: 5,
    unit: "s",
    /**
     * A target, and the one number the user sets. Two different things are
     * derived from it and they are not the same quantity:
     *
     * - `max_duration`, a decode limit: the AR stage generates acoustic frames
     *   until it emits its own end token or hits that limit, whichever comes
     *   first. So it is a cut-off, and a cut-off placed on the target is a cut
     *   through the ending of every song that landed on it. `ceilingSeconds`
     *   puts it above. The latent is sized from what the model actually
     *   produced (output 1 of the encode feeds node 37:15), so an unreached
     *   ceiling costs nothing and a short song is a short file rather than a
     *   long one padded with silence.
     * - The target itself, which reaches the model only as prose, because
     *   nothing in this graph carries a target length as a number:
     *   `max_audio_frames` never reaches the text and MiniMax's own API has no
     *   duration field either. So the levers on how long a track really runs
     *   are how much song the caption describes and how many sections the plan
     *   names — see musicConstraints and SECTION_PLANNER — plus `top_k`, which
     *   is the only one of the three that is mechanical.
     */
    help: "What the caption, the lyrics and the section plan are written to fill. The run is cut off a little past it. Top-k under Sampling is what stops the model ending early.",
    group: "Output",
    targets: [
      {
        node: ENCODE_NODE,
        input: "max_duration",
        transform: (value) => ceilingSeconds(Number(value)),
      },
      director,
      // The planner needs it too, and for the arithmetic rather than for the
      // prose: its durations have to add up to this number.
      lyricist,
    ],
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
  /**
   * The two guidance scales, which used to be one control.
   *
   * They carry the same number in the export and in ComfyUI's own shipped
   * template — 1.7 in both places — and that coincidence was the whole argument
   * for coupling them. It does not survive reading what they do. This model
   * generates in two stages: an autoregressive stage that writes the song as
   * acoustic tokens, and a diffusion stage that renders those tokens into
   * audio. `cfg_scale` guides the first, `cfg` guides the second, and they are
   * no more the same quantity than a screenplay is a camera.
   *
   * The coupling was also actively harmful given what the first one is for.
   * Raising guidance to hold a length is advice about the AR stage; carrying
   * the diffusion sampler up to 2.5 along with it changes how the audio is
   * rendered, for no reason anyone asked for.
   *
   * ComfyUI exposes neither in its template — both live inside a subgraph — so
   * there is no house default to disagree with beyond the 1.7 both start at.
   */
  {
    id: "guidance",
    label: "Caption guidance",
    type: "slider",
    default: 1.7,
    min: 1,
    max: 5,
    step: 0.1,
    /**
     * Classifier-free guidance on the AR stage's logits: `_guided_c0` builds
     * `unconditioned + (conditioned - unconditioned) * cfg_scale`. Raising it
     * pushes every token the caption argues against further down, the
     * end-of-song token included — so it holds a length for the same reason it
     * holds a genre, by taking the caption more literally.
     *
     * It does not change which tokens are candidates. That is `top_k`'s doing,
     * and the mask is built from the conditioned logits either way.
     */
    help: "How literally the song follows the caption — its genre, its sections, and where it ends. 2.0–2.5 holds a length better than the default; past 3 the music stiffens.",
    group: "Sampling",
    targets: [{ node: ENCODE_NODE, input: "cfg_scale" }],
  },
  {
    id: "sampler_cfg",
    label: "Sampler CFG",
    type: "slider",
    default: 1.7,
    min: 1,
    max: 5,
    step: 0.1,
    /**
     * The diffusion stage's own guidance, on a graph whose negative is a
     * ConditioningZeroOut of the positive — so what it weighs is the
     * conditioning against nothing at all, and moving it changes how hard the
     * renderer commits to the tokens rather than what those tokens are.
     *
     * Nothing about structure or length passes through here: by this point the
     * song is written and the sampler is turning it into sound.
     */
    help: "How hard the audio stage commits to what the song already is. Changes the sound, not the structure — 1.7 is the value the model ships with.",
    group: "Sampling",
    targets: [{ node: SAMPLER_NODE, input: "cfg" }],
  },
  {
    id: "top_k",
    label: "Top-k",
    type: "number",
    default: 50,
    min: 1,
    // The node itself allows the whole codebook, 16384. Anything past a few
    // hundred is the same wide-open sampling with a longer number in the box.
    max: 200,
    step: 1,
    /**
     * The one control that acts on length mechanically rather than by
     * persuasion, which is why the help says so.
     *
     * The AR stage's end-of-song token is an ordinary candidate in the same
     * distribution as the audio codes — `_sample_c0` in
     * comfy/ldm/minimax_music/ar.py takes the top `top_k` of the conditioned
     * logits, softmaxes them, and draws one. So the song ends the moment that
     * token happens to be drawn, and it can only be drawn on a frame where it
     * ranks inside the top `top_k`. Narrow the field and a mildly-likely stop
     * is excluded outright rather than left as a small chance.
     *
     * A small chance is the whole problem. At 25 frames a second a four-minute
     * track is 6000 draws, so even a 0.03% chance per frame ends it early more
     * often than not, and two runs of the same prompt come back very different
     * lengths.
     */
    help: "Narrows what the model may pick each frame. Lower holds the length better — the end-of-song token has to rank inside it to be chosen — at the cost of variety. Try 20, then 12; below 10 the music flattens.",
    group: "Sampling",
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
   * Where the lyrics field comes from, which is one of three places.
   *
   * A param cannot do this: `lyrics` on the encode node is either a string the
   * form wrote or a link to another node, and swapping a value for a link is a
   * change to the graph rather than to a value in it.
   *
   * - The lyricist writes it, and its output goes straight in. Nothing filters
   *   a lyric sheet: every line of it is meant to be sung.
   * - The section planner writes it, and it goes through node 48 first, which
   *   drops everything that is not a bracketed tag. Safe here and nowhere else
   *   — see the node's own comment.
   * - Otherwise the form wrote it, and both extra nodes go.
   *
   * Unused nodes are deleted rather than left in. ComfyUI executes only what an
   * output depends on, so a stray one would cost nothing at run time, but a
   * node with no consumer is a node someone wires up by accident later — and an
   * OAIAPI_ChatCompletion that did get executed would spend an API call to
   * produce nothing.
   */
  finalize(graph, values) {
    if (values.write_lyrics === true) {
      graph[ENCODE_NODE].inputs.lyrics = [LYRICIST_NODE, 0];
      delete graph[PLAN_GUARD_NODE];
      return;
    }

    // The one case the plan is for: no words from anywhere. `lyrics` has
    // already been trimmed by its own transform, so this reads the same value
    // the director was shown.
    if (values.plan_sections === true && !String(values.lyrics ?? "").trim()) {
      graph[ENCODE_NODE].inputs.lyrics = [PLAN_GUARD_NODE, 0];
      return;
    }

    delete graph[LYRICIST_NODE];
    delete graph[PLAN_GUARD_NODE];
  },
};
