import type { LyricLine } from './lyrics';

export type Mode = 'web' | 'images';

export type WordEvent = {
  t: number; // song seconds
  end: number;
  word: string;
  query: string;
  mode: Mode;
  breakBefore: boolean; // long gap before this word: clear the window pile
};

// Function words get the regular results page (dictionary card / Wikipedia title, like
// "when" and "was" in the video); everything else mostly gets Google Images.
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but nor so yet if then than that this these those there here when where why how what " +
    "which who whom whose while as at by for from in into of off on onto out over to up down with without " +
    "about above after again against all am are aren't be been before being below between both can can't " +
    "cannot could couldn't did didn't do does doesn't doing don't during each few further had hadn't has " +
    "hasn't have haven't having he he'd he'll he's her hers herself him himself his i i'd i'll i'm i've " +
    "is isn't it it's its itself just let's me more most mustn't my myself no not now only other ought our " +
    "ours ourselves own same shan't she she'd she'll she's should shouldn't some such their theirs them " +
    "themselves they they'd they'll they're they've through too under until very was wasn't we we'd we'll " +
    "we're we've were weren't what's when's where's who's why's will won't would wouldn't you you'd " +
    "you'll you're you've your yours yourself yourselves gonna wanna gotta ya yeah oh ooh ah uh like 'cause cause"
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text
    .replace(/[’‘`]/g, "'")
    .split(/[\s/]+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, ''))
    .filter((t) => /[\p{L}\p{N}&]/u.test(t));
}

function syllables(word: string): number {
  if (/^\d+$/.test(word)) return Math.max(1, word.length);
  const groups = word.toLowerCase().replace(/e\b/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function chooseMode(query: string): Mode {
  if (query === '&') return 'web';
  if (/^\d+$/.test(query)) return 'images';
  if (FUNCTION_WORDS.has(query)) return Math.random() < 0.15 ? 'images' : 'web';
  return Math.random() < 0.85 ? 'images' : 'web';
}

// LRC only times whole lines, so words are spread across each line by syllable weight,
// capped at a plausible singing speed when the line is followed by a long gap.
export function buildTimeline(lines: LyricLine[], songEnd = Infinity): WordEvent[] {
  const events: WordEvent[] = [];
  let pendingBreak = true;
  lines.forEach((line, i) => {
    const words = tokenize(line.text);
    const next = lines[i + 1]?.t ?? Math.min(songEnd, line.t + words.length * 0.5 + 1);
    if (!words.length) {
      pendingBreak = true;
      return;
    }
    const avail = Math.max(0.2, next - line.t);
    const syl = words.map(syllables);
    const weights = syl.map((s) => s + 0.4);
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.min(avail * 0.92, syl.reduce((a, b) => a + b, 0) * 0.28 + 0.25);
    const prevEnd = events.at(-1)?.end ?? -Infinity;
    let acc = 0;
    words.forEach((word, j) => {
      const t = line.t + (span * acc) / total;
      acc += weights[j]!;
      const query = word.toLowerCase();
      events.push({
        t,
        end: line.t + (span * acc) / total,
        word,
        query,
        mode: chooseMode(query),
        breakBefore: j === 0 && (pendingBreak || line.t - prevEnd > 4),
      });
    });
    pendingBreak = false;
  });
  return events;
}
