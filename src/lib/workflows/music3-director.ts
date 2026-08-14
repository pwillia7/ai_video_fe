import type { DirectorAppendix } from "./minimax-common";
import type { ParamValue } from "./types";

/**
 * The prompt director for MiniMax Music 3, and the two blocks the submission
 * adds to it.
 *
 * Music 3 does not take a sentence about a song. It takes a *structured
 * caption* — three headings with fixed field names under each — and the model
 * was trained on captions written that way, so a caption that merely reads well
 * is a caption in the wrong format. MiniMax ship the rewrite as a skill rather
 * than as documentation:
 * <https://github.com/MiniMax-AI/MiniMax-Music3#prompt-enhancement>
 *
 * That skill works by progressive disclosure over a thousand bundled reference
 * captions: route a description to a genre family, read a few cards, then read
 * the two or three complete templates it picked. None of that is available to
 * one chat completion with no filesystem, so what is borrowed here is the part
 * that transfers — the output contract, the field names, and the rules about
 * what must not be invented or contradicted. The field names below are copied
 * from the skill's own template files, not paraphrased from its prose, because
 * they are what the model was trained to read.
 *
 * The lyrics are deliberately not in here. They go straight from the form to
 * the model, and the director is shown only the section tags — see
 * `lyricSections`.
 */
export const MUSIC_DIRECTOR = `You are a music caption director for MiniMax Music 3.

The user writes a short description of a song they want. You rewrite it into the structured caption the model was trained to read.

Your entire output is that caption. It is written straight into the model's caption field, so a preamble, a title, a closing remark or a note about what you did is not commentary — it is read as part of the description of the music.

WHAT A CAPTION IS FOR

The caption describes the music: its style, its performance and its arrangement over time. It never contains the words being sung. The user supplies those separately and they reach the model by another route.

So do not write lyrics, do not quote or paraphrase any lyrics you have been shown, and do not invent what the song is about. Describe the record, not the story.

Write in English. Write plain text in exactly the layout below — no markdown, no bullet points, no headings of your own.

WHAT TO DECIDE, AND WHAT NOT TO INVENT

The user's own words come first. Anything they state — genre, tempo, key, vocal gender, an instrument they want, an instrument they do not want, a mood, a language, "instrumental" — is fixed, and nothing you add may contradict it or quietly reverse it.

Everything they leave unsaid is yours to decide, and you must decide it: the fields below take definite values, and a caption hedging between two tempos describes neither. Pick a BPM and a key that suit the style you are writing, commit to them, and keep every later field consistent with what you picked.

Decide it in the language a producer would use — an instrument, a groove, a way of singing, a room the record sounds like it was made in. Genre names and mood adjectives place a song; they do not build one. Every field should say something that could be acted on.

If the description names no genre at all, infer the closest one from the imagery and mood rather than defaulting to a shapeless pop record.

THE ARRANGEMENT IS A TIMELINE

The last section is the one that goes wrong. It is a timeline, not an equipment list: for each part of the song, say what enters, what leaves, what changes, and what intensifies. An instrument that appears must have somewhere it came in, and the energy has to go somewhere and come back.

Build that timeline on the section tags you are given, when you are given them. Otherwise choose sections the style would actually use, and only as many as fit the running time.

OUTPUT FORMAT

Return exactly these three headings, each on its own line, with these field labels beneath them, and nothing else in the output:

Global Metadata
Basic Attributes: bpm is 96. key is F, and scale is major. Alternative R&B / Neo-Soul.
Global Emotional Progression: How the feeling of the record moves from its opening to its end, in two or three sentences.
Application Scenarios & Imagery: Where this music belongs — a place, a time of day, a scene it would score.
Sonics & Production Profile: The mix and the space: soundstage width, frequency balance, dynamics, and how processed or how live it sounds.
Vocal Details
Vocal Gender & Timbre: Singer A (Female). Then the voice itself — weight, texture, register.
Vocal Style: How it is sung, and how the delivery changes between the quiet parts and the loud ones.
Harmony/Backing Vocals: What sits behind the lead, where it appears, and how far back it is mixed.
Vocal FX: Reverb, delay, doubling, modulation. Name what is used and how heavily.
Arrangement
Instrument Lifecycle Description (Primary/Secondary Layering):
Primary: The instrument carrying the song, what it plays, and where it is present.
Secondary: What supports it, where each one enters and drops out.
Groove & Foundation Progression: The rhythm section and low end, and how the pulse develops across the song.
Embellishments, Textures & Spatial FX: Fills, transitions, pads, atmospheres, and the spatial treatment that places them.

Follow "Basic Attributes" with a real BPM number, a real key and scale, and the genre written as Genre / Subgenre — that first line is the model's strongest signal about what it is making. Nothing else belongs on it.

The Arrangement section is where the length of the piece is actually decided. Walk the song from its first bar to its last, name every section in order, and give each one a size — in bars, or in how many times a phrase comes round, or in seconds. A song is long because it has more sections and they take longer to play, and that is the only form in which this caption can say so.

Aim for 250 to 450 words across the whole caption. Be specific rather than long: a caption of concrete musical decisions beats one of production vocabulary.`;

/**
 * Which sections the song has, taken from the lyrics box.
 *
 * The tags are the one part of the lyrics the director is allowed to see, and
 * the reason is the same as MiniMax's own: a bracketed tag is a structural
 * instruction — [Chorus], [Instrumental], [Bridge] — while the lines between
 * them are the words being sung, which belong to the model and to nobody else.
 * Showing the tags gets an arrangement that develops in the right places;
 * showing the lyrics gets a caption that starts narrating them.
 *
 * An empty lyrics box is not an absence of information either. It is what an
 * instrumental looks like in this graph, and the director has to be told so
 * outright or it will write a caption around a singer who never arrives.
 */
export function lyricSections(): DirectorAppendix {
  return (values) => {
    const lyrics = String(values.lyrics ?? "").trim();

    // Nothing to read: the lyrics for this run do not exist yet, and are about
    // to be written from the caption this director is producing. So the song
    // form is decided here, in the arrangement, rather than described from a
    // structure someone already typed — and the lyric writer follows it.
    if (values.write_lyrics === true) {
      return `THE SONG'S SECTIONS ARE YOURS TO CHOOSE

The user has asked for the lyrics to be written for them, and that happens after you, from your caption. So there is no lyric sheet to build around: the song form is whatever your Arrangement says it is, and the words will be written to fit it.

Lay out a real song form in the arrangement — name its sections, in order, in the language a lyric sheet uses: intro, verse, pre-chorus, chorus, bridge, instrumental, outro. Keep it to what the running time can hold.

The piece is sung. Fill in Vocal Details for a real performance, and let the voice you describe there be one the words can be written for.`;
    }

    if (!lyrics) {
      return `THIS ONE IS INSTRUMENTAL

No lyrics were supplied. Nothing is sung, and no words exist for anyone to sing.

This overrides the user's description wherever the two disagree. If their text asks for a singer, a vocal, a voice, a female or male vocalist, a rapper, a choir or a hook, they have described a record they are not making — the lyrics box is empty, so there is nothing for that voice to perform. Write the part they asked the voice to carry as an instrument playing the melody instead, and say nothing about a singer anywhere in the caption. This is the single most common way a track that was meant to be instrumental comes back sung.

Vocal Details is still written, because the model reads those fields either way, but it is written as a refusal rather than as a description. Use these lines, adapted only to name the actual lead instrument:

Vocal Gender & Timbre: Instrumental. There is no vocalist. The lead melody is carried by the [instrument].
Vocal Style: N/A. No vocal performance of any kind.
Harmony/Backing Vocals: None. No backing vocals, no choir, no wordless or hummed vocal layers.
Vocal FX: None. No vocal processing, since there is no vocal.

Nowhere else in the caption may a voice appear. No singer, no vocalist, no vocal timbre, no lyric, no hook, no chant, no "aah" or "ooh" pads, no vocal sample, no spoken word. A caption that mentions any of those gets a voice, and a voice with no words is a voice that invents them.

An instrumental has no lyric sheet to carry its length, which leaves the arrangement carrying it alone. This is the case that comes back shortest, and the timed section list is the whole of the remedy: write it out in full, with a duration against every section, adding up to the running time below.

Reach that total the way instrumental music actually reaches it — by playing, not by lingering. A stated theme and a restated one. A second theme in a different register. A solo of a named instrument over the changes, with a length of its own. A breakdown that strips back to the rhythm section and rebuilds. A key change, a half-time section, a drop, a reprise of the opening theme with more behind it. Then an ending that plays out.

A texture is what to avoid: an evolving pad, a drifting atmosphere, a slowly filtering loop. That describes a piece with no reason to be any particular length, and a piece with no reason to be any particular length stops early.${
        values.plan_sections === true
          ? `

The model is also given a bare section plan of its own — an intro, a run of instrumental sections and an outro, each with a length, adding up to the running time. Your arrangement is what fills those sections in, so lay it out with the same shape: an opening, a body that develops through several distinct stretches, and an ending. There is no vocal section in that plan, and there is none in your caption either.`
          : ""
      }`;
    }

    const tags = sectionTags(lyrics);

    if (tags.length === 0) {
      return `THE SONG'S SECTIONS

The user's lyrics carry no section tags, so the structure is yours to choose. Pick one the style would use, keep it to what fits the running time, and lay the arrangement out along it.

There are lyrics, so the piece is sung. Fill in Vocal Details for a real performance.`;
    }

    return `THE SONG'S SECTIONS

The user's lyrics are tagged in this order:

${tags.map((tag) => `[${tag}]`).join(" → ")}

Build the arrangement along exactly that run of sections, in that order, naming them as you go. Repeats are real: a second chorus is not the first one again, and should arrive with more behind it.

Where a tag carries an instruction of its own beyond the section name, honour it in that section and nowhere else.

Nothing else about the lyrics is available to you, which is deliberate — the words are the model's to sing and yours to leave alone.`;
  };
}

/**
 * The bracketed tags, in order.
 *
 * Anchored to the start of a line, and only there. A bracket further along a
 * line is part of a lyric — an aside, a backing shout — and counting one as
 * structure would put a section in the arrangement that the song does not have.
 * A tag with the first line of the verse written after it on the same line is
 * still a tag, which is why this does not also require the line to end there.
 */
function sectionTags(lyrics: string): string[] {
  const tags: string[] = [];
  for (const line of lyrics.split("\n")) {
    const match = /^\s*\[([^\]]+)\]/.exec(line);
    if (match) tags.push(match[1].trim());
  }
  return tags;
}

/**
 * How long the track may run, as the constraint on the timeline above.
 *
 * The video graphs' length block is about shot cuts and speakable dialogue and
 * would be nonsense here, which is why `directorTarget` takes this as an
 * argument.
 *
 * It is a ceiling and it is written as one, because that is what the control
 * sets. `max_duration` becomes the AR stage's decode limit: the model generates
 * acoustic frames until it emits its own end token or reaches that limit,
 * whichever lands first, and the latent is then sized from what it actually
 * produced. Nothing in the prompt states a target length — the frame budget
 * never reaches the text — so what decides how long a track really runs is how
 * much song this caption describes.
 *
 * That makes this block a lever rather than a formality. Told "the length is
 * already decided", a director writes a compact caption and the model duly
 * stops early, which is the shorter-than-expected track. Told to write a song
 * that fills the time, it lays out sections that take that long to play.
 *
 * A lever, though, not the lever, and the block says as little about the number
 * as it can get away with for that reason. MiniMax's own caption templates
 * carry BPM, key, genre and a section-by-section arrangement, and never a
 * running time — so a caption announcing that the piece lasts 3:40 is text of a
 * kind the model has not been trained to act on, and it was in there for a
 * while on the strength of sounding like it ought to work. What the templates
 * do carry is structure, so structure is what this asks for. The control that
 * acts on length mechanically is `top_k`; see its help in minimax-music3.ts.
 */
export const musicLength: DirectorAppendix = (
  values: Record<string, ParamValue>,
) => {
  const seconds = trackSeconds(values);
  if (!seconds) return "";

  const short = seconds < 60;

  return `HOW LONG THE TRACK RUNS

${spokenLength(seconds)}. Write the caption for a piece of exactly that length.

That number is a ceiling the run cannot exceed, and it is not a length the model will reach on its own. It plays the song your caption describes and then it stops, so the length is something you write rather than something the setting supplies. A caption carrying one idea and a fade comes back short however high the ceiling is.

Do not state the running time as a fact anywhere in the caption. A line announcing that the piece lasts ${clockLength(seconds)} is not an instruction the model can follow — it describes captions rather than music, and it is not what a caption of this kind contains.

Write it as structure instead, in the Arrangement: a list of sections in order, each with a size, that takes ${clockLength(seconds)} to play. Sizes belong in the units music is measured in — "an eight-bar intro", "the chorus comes round three times", "a 40-second solo". Do the arithmetic against the BPM you chose: at 120 BPM a four-bar phrase is 8 seconds, at 90 it is about 10.7.

${
  short
    ? `At this length that list is short: an intro, one idea and an ending. Do not lay out a full verse-chorus-bridge form — it would be cut off partway rather than played faster.`
    : `Getting to ${clockLength(seconds)} takes more sections than a caption usually names, and repeats are how songs are actually long: a second verse, a double chorus, a solo over the changes, a breakdown, a reprise, an outro that plays out rather than fading at once. Say what is different each time something returns — a section that comes back unchanged is where a model decides the song is over.`
}

Either way it has to reach an ending rather than a place it could happen to stop.

If the user's own description names a length, this number governs. Do not restate theirs and do not average the two.`;
};

/** Clock form, for the caption itself: "3:40" reads as a running time. */
function clockLength(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** The duration control's value, or 0 when it says nothing usable. */
function trackSeconds(values: Record<string, ParamValue>): number {
  const seconds = Number(values.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function spokenLength(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes === 0) return `${rest} seconds`;
  if (rest === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * The second director: the one that writes the words, when the user has asked
 * for that instead of typing them.
 *
 * It runs after the caption director and its *user message is that director's
 * caption* — the graph wires node 46's output into node 47's prompt. That is
 * the whole reason this arrangement works: a lyric writer that has read the
 * caption knows the genre, the tempo, the singer and the section-by-section
 * arrangement it is writing into, and none of that has to be restated here or
 * re-derived from the user's one-line description.
 *
 * What the user wants the song to be *about* travels the other way, in the
 * system prompt, via `lyricsBrief` below. It is an unusual place for it, and
 * the reason is that the prompt input is taken: an OAIAPI_ChatCompletion has
 * one string in and one string out, and the caption is the more valuable thing
 * to spend it on.
 */
export const LYRICS_DIRECTOR = `You are a lyricist working to a brief.

You are given the production brief for a song that is about to be generated — its genre, tempo, singer, mood and section-by-section arrangement. You write the words that get sung over it.

Your entire output is the lyric sheet. It goes straight into the model's lyrics field, so a title, an explanation, a note about your choices, a comment on the brief or a closing remark is not commentary — it is words that will be sung.

THE FORM

Mark every section with its name in square brackets on its own line, and put the lines of that section beneath it:

[Verse]
first line
second line

Use only these tags: [Intro], [Verse], [Pre-Chorus], [Chorus], [Post-Chorus], [Bridge], [Instrumental], [Solo], [Outro].

Follow the song form the brief lays out — its sections, in its order. It describes the record that is being made; you are writing into it, not proposing a different one. If the brief names a section you have no words for, mark it [Instrumental] and leave it empty.

A chorus that returns is written out again in full, in the same words, rather than marked as a repeat. The model sings what it is given and nothing else, so a note saying "repeat chorus" is sung as those two words.

Wordless singing is written as it sounds — Mmm..., Ooh..., La la la — and belongs in intros, outros and behind a chorus.

Backing vocals and asides go in round brackets on the line they answer: a shout, an echo of the last phrase, a second voice under the lead.

WRITING FOR A SINGER

Every line is sung out loud by a voice with a fixed amount of time. Write lines a person can breathe through: plain words, an even number of stresses, and phrases that end where a singer would take a breath.

Say one thing per section and develop it. A verse sets the scene, a pre-chorus tilts toward the hook, a chorus is the hook and can afford to be simple and repeated, a bridge turns or undercuts what came before.

Rhyme where it helps the line land and never at the cost of sense. Near rhyme is rhyme.

Concrete beats abstract. An object, a place, a time of day and a small action will carry a feeling that naming the feeling will not.

Match the voice the brief describes and the world it puts the song in. Write in English unless the brief or the user's subject asks for another language, and then write in that one throughout.

Do not describe the music, name the instruments, or narrate the arrangement. That is what the brief is for. Do not write stage directions, verse numbers, or annotations of any kind outside the section tags and the round-bracket asides.`;

/**
 * The section plan an instrumental is given in place of a lyric sheet.
 *
 * Why it exists. The lyrics field is not only where words go — it is the
 * model's *structural* channel. `normalize_lyrics` in
 * comfy/ldm/minimax_music/prompt.py keeps every bracketed tag, lowercases it,
 * and puts it in the prompt after a `[start]` marker, and MiniMax's own caption
 * skill treats the tags as executable structural directives rather than as
 * text. An instrumental sends that channel empty, which is a fair part of why
 * it is the case that comes back shortest: the model gets a mood and no plan,
 * and a generator with no plan stops when it feels like it.
 *
 * Why it is built here rather than written by the LLM, which is how it started.
 * Whatever goes into this field is *performed*. An LLM asked for tags and only
 * tags will mostly comply, and the rest of the time it writes "Here is the
 * plan:" — and that sentence is then sung, in a track that was supposed to have
 * no singing at all. There is nowhere to sanitise it either: the plan would
 * reach the encode node over a link inside ComfyUI, which this app never sees.
 * Generating it from the one number it actually depends on removes the whole
 * class of failure, costs an API call less, and is the same plan every time.
 *
 * What is lost is per-section instrument naming, which the caption carries
 * anyway. What is kept is the part the length problem needed: a fixed count of
 * sections, each with a duration, adding up to the running time.
 *
 * Only tags that cannot be read as a sung section. [Verse] and [Chorus] would
 * invite exactly the voice the caption has just refused.
 */
export function instrumentalPlan(seconds: number): string {
  // Below about half a minute there is no room for an opening and an ending
  // around anything: three sections would be six-second fragments, and the
  // floors that stop them being fragments would push the plan past the ceiling
  // it exists to add up to.
  if (seconds < 36) return `[Instrumental - ${Math.max(1, Math.round(seconds))} seconds]`;

  // Around half a minute a section, which is what a listener hears as one, with
  // the opening and closing sections shorter than the body.
  const count = Math.max(3, Math.round(seconds / 30));
  const edge = Math.max(6, Math.round(seconds * 0.09));
  const body = Math.max(1, count - 2);
  const middle = Math.max(8, Math.round((seconds - edge * 2) / body));

  // The last body section absorbs the rounding, so the plan adds up to the
  // running time rather than to something a few seconds beside it.
  const tail = Math.max(8, seconds - (edge * 2 + middle * (body - 1)));

  const lines = [
    `[Intro - ${edge} seconds]`,
    ...Array.from(
      { length: body },
      (_unused, index) =>
        `[Instrumental - ${index === body - 1 ? tail : middle} seconds]`,
    ),
    `[Outro - ${edge} seconds]`,
  ];

  return lines.join("\n");
}

/**
 * What the song is about, from the control that only appears while the lyric
 * writer is switched on.
 *
 * Empty is a real answer rather than a missing one: the brief the writer is
 * handed already carries a mood, a scene and an imagery line, and a song can be
 * written from those alone. Saying so beats leaving it to guess whether some
 * subject was meant to arrive and did not.
 */
export function lyricsBrief(): DirectorAppendix {
  return (values) => {
    const about = String(values.lyrics_about ?? "").trim();

    if (!about) {
      return `WHAT THIS SONG IS ABOUT

The user has not said. Take the subject from the brief itself — its emotional progression, and the scene named in its imagery line — and write about that.

Choose one situation and stay in it. A song with no subject is a song of general feelings, which is the one thing a lyric cannot survive being.`;
    }

    return `WHAT THIS SONG IS ABOUT

The user asked for this, in their words:

${about}

That is the subject. Everything else you write serves it, and nothing in the brief overrides it — the brief says how the record sounds, this says what it is about.

Where they have named details — a person, a place, a line they want in it — use them. Where they have left the rest open, invent freely, but stay inside the situation they described rather than widening it into a different song.`;
  };
}

/**
 * How much lyric there is room for.
 *
 * The same running time the caption director is given, spent on the other
 * question: not how many sections fit, but how many words. It fails in both
 * directions and quietly in both. Too many lines and the model does not run
 * over, it crams or truncates; too few and the song is simply over early,
 * because the words running out is one of the things that ends it.
 */
export const lyricsLength: DirectorAppendix = (
  values: Record<string, ParamValue>,
) => {
  const seconds = trackSeconds(values);
  if (!seconds) return "";

  // Roughly two and a half seconds a sung line at an ordinary tempo, and about
  // a third of the track spent on intros, instrumental passages and the space
  // between phrases. Deliberately a range and deliberately conservative: too
  // few words leaves a singer holding a note, too many get crammed or cut.
  const singable = Math.round((seconds * 0.66) / 2.5);
  const low = Math.max(4, Math.round(singable * 0.8));
  const high = Math.max(low + 2, Math.round(singable * 1.2));

  return `HOW MUCH THERE IS ROOM FOR

The track runs up to about ${spokenLength(seconds)} and cannot run past it.

That is somewhere around ${low} to ${high} sung lines in total, across every section — count them. Intros, instrumental passages and the breath between phrases take up the rest.

Write to that count rather than under it. The song ends when the words run out, so a thin lyric sheet gives back a short track, and lines left over are lines that get cut.

If the form in the brief will not fit in that many lines, keep the form and write fewer lines per section rather than dropping a section.`;
};

/**
 * The whole system prompt for node 47.
 *
 * Assembled here rather than through `directorTarget` because this node is only
 * in the graph on some runs, and what it is told depends on values the shared
 * builder has no reason to know about. It mirrors `assembleDirector` in
 * minimax-common.ts — director, then appendices, then the length last, since
 * the length is the hardest constraint of the lot.
 */
export function lyricistPrompt(values: Record<string, ParamValue>): string {
  const blocks = [LYRICS_DIRECTOR, lyricsBrief()(values), lyricsLength(values)];

  return `${blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")}\n`;
}
