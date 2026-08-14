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

Follow "Basic Attributes" with a real BPM number, a real key and scale, and the genre written as Genre / Subgenre — that first line is the model's strongest signal about what it is making.

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

No lyrics were supplied, so nothing is sung. Under Vocal Details, say that the piece is instrumental and name the instrument carrying the lead melody in place of a voice — that section still has to be filled in, because the model reads it either way.

Do not describe a singer, a vocal timbre, backing vocals or vocal effects, and do not write a caption that implies a vocal is coming.`;
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
 * How long the track runs, as the constraint on the timeline above.
 *
 * The video graphs' length block is about shot cuts and speakable dialogue and
 * would be nonsense here, which is why `directorTarget` takes this as an
 * argument. What a running time decides for a song is how many sections there
 * is room for — the failure it prevents is a caption planning verse, chorus,
 * bridge and final chorus into forty seconds.
 */
export const musicLength: DirectorAppendix = (
  values: Record<string, ParamValue>,
) => {
  const seconds = trackSeconds(values);
  if (!seconds) return "";

  return `HOW LONG THE TRACK IS

This one runs about ${spokenLength(seconds)}. That is already decided and the caption cannot change it.

Fit the arrangement inside it. Every section you describe has to have room to be heard — under a minute is an intro, one idea and an ending, not a full song form — and the piece must reach an ending rather than being cut off mid-phrase.`;
};

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
 * question: not how many sections fit, but how many words. A lyric sheet
 * written for three minutes and sung in forty seconds is the failure here, and
 * it is a quiet one — the model does not run over, it crams or truncates.
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

The track runs about ${spokenLength(seconds)}, and that is fixed. Everything you write has to be sung inside it.

That is somewhere around ${low} to ${high} sung lines in total, across every section — count them. Intros, instrumental passages and the breath between phrases take up the rest.

If the form in the brief will not fit in that many lines, keep the form and write fewer lines per section rather than dropping a section.`;
};
