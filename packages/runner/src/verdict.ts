import { VERDICT_PREFIX, VERDICTS, type Verdict } from '@nolzu/protocol';

/**
 * What one QA run decided, read back from what it printed.
 *
 * `--output-format json` structures the envelope only, so the verdict arrives as text and a second
 * pass over that text is what finds it. The words it looks for come from `@nolzu/protocol`, which
 * is also where the qa skill's rule text takes them from, so the line the skill writes and the line
 * this reads cannot drift apart.
 */
export interface QaVerdict {
  verdict: Verdict;
  // Null when the line carried no sentence. The card then says the reason is missing, because
  // losing a failure over a missing sentence is the worse mistake.
  reason: string | null;
}

const isVerdict = (word: string): word is Verdict => (VERDICTS as readonly string[]).includes(word);

/**
 * The verdict a run printed, or null when it printed none.
 *
 * Two rules the verdict text settles, so nothing here guesses. The line stands on its own, so a
 * verdict word inside a sentence never counts. The last verdict line wins, because a run often
 * echoes its own report and the line meant for the card is the one it ends with.
 */
export function extractVerdict(text: string): QaVerdict | null {
  let found: QaVerdict | null = null;

  for (const raw of text.split('\n')) {
    // Trimmed, because the rule asks for nothing before the word and indentation is not something.
    const line = raw.trim();
    if (!line.startsWith(VERDICT_PREFIX)) continue;
    const rest = line.slice(VERDICT_PREFIX.length).trim();
    const word = rest.split(/\s+/)[0] ?? '';
    // A word outside the three is not a verdict. Reading one would invent a decision nobody made.
    if (!isVerdict(word)) continue;
    const reason = rest.slice(word.length).trim();
    found = { verdict: word, reason: reason === '' ? null : reason };
  }

  return found;
}
