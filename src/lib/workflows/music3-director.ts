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
 * that transfers — the output contract, the field names, the constraint
 * hierarchy, and the rules about what must not be invented or contradicted. The
 * field names below are copied from the skill's own template files, not
 * paraphrased from its prose, because they are what the model was trained to
 * read.
 *
 * The hierarchy is the skill's own five rungs in its own order: user
 * requirements, then section-local directives from bracketed tags, then caption
 * implications, then reference characteristics, then conservative defaults.
 * Only the fourth is reworded, because there are no reference templates on this
 * side of it — a chat completion with no filesystem never opens one — and "what
 * the style would conventionally do" is what that rung is actually standing in
 * for here.
 *
 * What the skill has no answer for at all is length. It accepts a desired
 * length as a constraint and then defines no mechanism for honouring one: its
 * Arrangement is "a section-by-section timeline" with no times in it, and the
 * generation API it feeds has no duration field either — only `max_new_tokens`,
 * a cap of 9000 acoustic frames, which is the ceiling this app writes to
 * `max_duration`. So everything below about section sizes is a local extension
 * rather than the documented contract, and it is here because the documented
 * contract is what comes back short.
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

When two things you have been given disagree, settle it in this order:

1. What the user asked for, including the constraints at the end of these instructions.
2. A directive carried inside a section tag, which governs its own section and no other.
3. What the description implies without saying.
4. What the style would conventionally do.
5. A conservative default.

Nothing lower on that list may overturn anything above it. A convention of the genre is not a reason to quietly drop something the user asked for.

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

Your arrangement is also being turned into a section plan for the model. A second pass reads the caption you are about to write, takes the sections out of your Arrangement, and hands the model that list with a duration against each one — so the plan is only as good as the walk you write, and a stretch of the piece you leave untimed is a stretch that pass has to invent a length for.

So name every section, in order, and give each one a size. An opening, a body that develops through several distinct stretches, and an ending. No section of that plan is a vocal one, and none of your caption's is either.`
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
 * The user's own requirements, which today means how long the track should run.
 *
 * A constraints block rather than a length block, and it is the last thing the
 * director reads, because the hierarchy above puts it at the top: this is the
 * rung everything else defers to. Exclusions and creative direction belong here
 * too the moment they get controls of their own — at present they are typed
 * into the description, where they still outrank everything but arrive without
 * being labelled as requirements.
 *
 * The video graphs' length block is about shot cuts and speakable dialogue and
 * would be nonsense here, which is why `directorTarget` takes this as an
 * argument.
 *
 * A target, and written as one. The control sets a target and the ceiling is
 * derived from it — see `ceilingSeconds` — because the two are not the same
 * quantity and setting them equal punishes the run that went right: a song the
 * caption lands exactly on the target loses its last bar to a cut-off placed
 * exactly there. What the ceiling actually is: `max_duration` becomes the AR
 * stage's decode limit, the model generates acoustic frames until it emits its
 * own end token or reaches that limit, and the latent is then sized from what
 * it produced. Nothing in the prompt states a target — the frame budget never
 * reaches the text — so what decides how long a track really runs is how much
 * song this caption describes.
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
export const musicConstraints: DirectorAppendix = (
  values: Record<string, ParamValue>,
) => {
  const seconds = trackSeconds(values);
  if (!seconds) return "";

  const short = seconds < 60;

  return `CONSTRAINTS

What follows is what the user asked for, and it is the top rung of the order above. Nothing you infer from their description, and nothing the style would usually do, may overturn it.

Target length: ${spokenLength(seconds)}. Write the caption for a piece of exactly that length.

The run is cut off at ${clockLength(ceilingSeconds(seconds))}, which is a hard stop rather than a target — a song your caption makes longer than ${clockLength(seconds)} loses its ending mid-bar. The far commoner failure is the other one: nothing in this system tells the model to keep playing, so it plays the song your caption describes and stops, and a caption carrying one idea and a fade comes back short however far away the cut-off is.

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

/**
 * The decode ceiling that goes with a target length.
 *
 * `max_duration` is a cut-off, not a length: the AR stage generates until it
 * emits an end token or hits this, and whatever it produced by then is the
 * track. So a ceiling set to the target is a guillotine on the good outcome —
 * the caption lands the song on 3:40 and the last bar is the one that does not
 * fit. The headroom is what makes an ending possible.
 *
 * It costs nothing to be generous with. The latent is sized from what the model
 * actually produced (node 37:15 reads output 1 of the encode), so an unreached
 * ceiling is not silence on the end of the file, and the frames are never
 * generated. What it does buy is the occasional track that runs over the target
 * by up to this much, which is the right way round: a song that plays out is
 * worth more than one clipped exactly on time.
 *
 * 360s is the node's own hard limit — MAX_AUDIO_FRAMES / AUDIO_FRAMES_PER_
 * SECOND, 9000 / 25, in comfy/ldm/minimax_music/ar.py — and the clamp is what
 * keeps the derived value inside it. The duration control stops at 300 so the
 * headroom is real at every setting rather than quietly vanishing at the top.
 */
export function ceilingSeconds(target: number): number {
  return Math.min(360, Math.round(target * 1.15));
}

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
 * The other job node 47 does: the section plan an instrumental is given in
 * place of a lyric sheet.
 *
 * Why the field is worth filling at all. The lyrics field is not only where
 * words go — it is the model's *structural* channel. `normalize_lyrics` in
 * comfy/ldm/minimax_music/prompt.py keeps every bracketed tag, lowercases it,
 * and puts it in the prompt after a `[start]` marker, and MiniMax's own caption
 * skill treats bracketed tags as the one part of a lyric sheet that is
 * executable. An instrumental sends that channel empty, which is a fair part of
 * why it is the case that comes back shortest: the model gets a mood and no
 * plan, and a generator with no plan stops when it feels like it.
 *
 * Why an LLM writes it, having been arithmetic in this file until now. The plan
 * and the caption describe the same piece, and written by different authors
 * they agree only in shape — a computed plan is a row of identical blocks, and
 * the caption gets told to bend its arrangement to fit them. Written here the
 * dependency runs the right way: node 47's user message is node 46's output, so
 * the sections are the ones the caption actually described, at the lengths it
 * gave them, and a 40-second solo is a 40-second solo in both places.
 *
 * What that costs is exactly why it was arithmetic before. Whatever lands in
 * this field is *performed*; this app never sees node 47's output, since it
 * reaches the encode node over a link inside ComfyUI; and an LLM asked for tags
 * and only tags will mostly comply and occasionally write "Here is the plan:",
 * which is then sung, in a track that was supposed to have no singing in it.
 * That failure is no longer unguarded — node 48 is a RegexReplace that drops
 * every line not opening with a bracket, which is only safe on this path
 * because a plan is nothing but brackets. The prompt below is written to make
 * the guard redundant; the guard is there because "mostly" is not a rate worth
 * shipping. See `finalize` in minimax-music3.ts for the wiring.
 *
 * Only tags that cannot be read as a sung section. [Verse] and [Chorus] would
 * invite exactly the voice the caption has just refused.
 */
export const SECTION_PLANNER = `You are laying out the section plan for an instrumental piece of music.

You are given the production brief for a piece that is about to be generated. Its Arrangement already walks the piece from its first bar to its last. Write that walk out as a bare list of timed sections.

Your entire output is that list. It goes straight into the model's structural channel — the field a lyric sheet would occupy — and everything in that field is performed. A heading, an explanation, a note about the arithmetic or a closing remark is not commentary: it is something the piece will try to play, in a track that has no voice to play it with. The first character you write is "[" and the last is "]".

THE FORM

One section per line, and every line exactly this shape:

[Name - 24 seconds]

Name is one of: Intro, Instrumental, Theme, Solo, Breakdown, Build, Interlude, Reprise, Outro.

Nothing else on a line. No instrument, no description, no bar count, no running total, no blank lines between sections — the brief carries all of that, and this list carries only the shape.

Use only those names. [Verse] and [Chorus] are instructions to sing, and this piece has no singer; a plan naming one is how an instrumental comes back with a voice on it.

WHERE THE SECTIONS COME FROM

Take them from the brief's Arrangement, in its order. Where it gives a section a size — in bars, in repeats, in seconds — convert that to seconds against the BPM it names, and use it. Where it leaves one unsized, give it a length that suits what it describes: a stated theme runs longer than the transition into it, a solo longer than the fill that ends it.

Keep every section between 8 and 60 seconds. Shorter than that is a gesture rather than a section; longer is a stretch of music with nothing happening in it.

THE ARITHMETIC

The durations have to add up to the target length below. Not close to it — to it exactly.

So write the list, add the numbers up, and if the total is not the target, lengthen or shorten one section in the middle until it is. Do that before you answer, and let the corrected list be the whole of your answer.`;

/**
 * What the planner is aiming at: the same target the caption director was
 * given, spent on the one question the plan has to answer.
 *
 * The section count is the old computed plan's arithmetic, kept because it was
 * the part worth keeping — about half a minute a section is what a listener
 * hears as one, and below about 36 seconds there is no room for an opening and
 * an ending around anything. It is offered as a density rather than imposed as
 * a count, since the caption's own arrangement is the better authority on how
 * many sections this particular piece has.
 */
export const plannerLength: DirectorAppendix = (
  values: Record<string, ParamValue>,
) => {
  const seconds = trackSeconds(values);
  if (!seconds) return "";

  if (seconds < 36) {
    return `THE TARGET LENGTH

The piece runs ${spokenLength(seconds)}, which is too short to be built out of parts.

Write one line, and one only: a single section of ${Math.round(seconds)} seconds, named for whatever the brief's arrangement is mostly doing.`;
  }

  const count = Math.max(3, Math.round(seconds / 30));

  return `THE TARGET LENGTH

The piece runs ${spokenLength(seconds)}. Your durations add up to exactly ${Math.round(seconds)}.

At this length that is usually around ${count} sections. Fewer and longer is fine if the brief describes a piece that develops slowly; more and shorter is fine if it describes one that moves. Fewer than three is not a plan.

The first section is the opening and the last is the ending, and both are shorter than the ones between them.`;
};

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

The track is being written to run about ${spokenLength(seconds)}, and is cut off shortly past that.

That is somewhere around ${low} to ${high} sung lines in total, across every section — count them. Intros, instrumental passages and the breath between phrases take up the rest.

Write to that count rather than under it. The song ends when the words run out, so a thin lyric sheet gives back a short track, and lines left over are lines that get cut.

If the form in the brief will not fit in that many lines, keep the form and write fewer lines per section rather than dropping a section.`;
};

/**
 * The whole system prompt for node 47, which is two prompts depending on what
 * the run asked that node for.
 *
 * One node and two jobs, because both of them are the same request — read the
 * caption node's output, write the field that gets performed — and they are
 * never both wanted on one run: the lyricist writes words for a sung track, the
 * planner writes sections for an instrumental. A second OAIAPI_ChatCompletion
 * would be a second API client, a second node to delete, and the same prompt
 * assembly twice.
 *
 * Assembled here rather than through `directorTarget` because this node is only
 * in the graph on some runs, and what it is told depends on values the shared
 * builder has no reason to know about. It mirrors `assembleDirector` in
 * minimax-common.ts — director, then appendices, then the length last, since
 * the length is the hardest constraint of the lot.
 *
 * Written on every run, including the ones where node 47 is deleted before the
 * graph is queued, so the planner branch is also what an unused node carries.
 * See the `lyricist` target in minimax-music3.ts.
 */
export function lyricistPrompt(values: Record<string, ParamValue>): string {
  const blocks =
    values.write_lyrics === true
      ? [LYRICS_DIRECTOR, lyricsBrief()(values), lyricsLength(values)]
      : [SECTION_PLANNER, plannerLength(values)];

  return `${blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")}\n`;
}
