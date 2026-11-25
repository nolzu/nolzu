import { chmodSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { stubBinary } from '../test/stub-binary.ts';
import { cursorModels, parseCursorModels } from './cursor-models.ts';

// What `cursor-agent --list-models` printed on 2026-09-25, cut to the shapes that matter:
// the heading, the default, an id with an effort in it, one with an effort and the fast suffix,
// three that carry no effort at all, the blank lines, and the tip the list ends with. The colours
// are the binary's own.
const LISTED = [
  '\u001B[2mAvailable models\u001B[22m',
  '',
  '\u001B[36mauto\u001B[39m \u001B[2m- Auto\u001B[22m\u001B[2m (default)\u001B[22m',
  '\u001B[36mclaude-opus-5-5-high\u001B[39m \u001B[2m- Claude Opus 5.5 1M High\u001B[22m',
  '\u001B[36mclaude-opus-5-5-high-fast\u001B[39m \u001B[2m- Claude Opus 5.5 1M High Fast\u001B[22m',
  '\u001B[36mgpt-5.3-codex\u001B[39m \u001B[2m- Codex 5.3\u001B[22m',
  '\u001B[36mcomposer-2.5\u001B[39m \u001B[2m- Composer 2.5\u001B[22m',
  '\u001B[36mkimi-k2.7-code\u001B[39m \u001B[2m- Kimi K2.7 Code\u001B[22m',
  '',
  "\u001B[2mTip: use \u001B[36m--model <id>\u001B[39m (or \u001B[36m/model <id>\u001B[39m in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. \u001B[36m--model 'claude-opus-4-8[context=1m,effort=high,fast=false]'\u001B[39m.\u001B[22m",
].join('\n');

it('reads the ids out of the printed list', () => {
  expect(parseCursorModels(LISTED)).toEqual(['claude-opus-5-5-high', 'claude-opus-5-5-high-fast', 'gpt-5.3-codex', 'composer-2.5', 'kimi-k2.7-code']);
});

// auto lets the vendor change the model inside the run, so the card would name one model and the
// run would use another. It is dropped here, which is also what keeps it off every picker.
it('leaves auto out', () => {
  expect(parseCursorModels(LISTED)).not.toContain('auto');
});

// The list is prose around the ids. A heading or a tip read as a model would put a name in the
// picker that no run can ask for.
it('reads nothing out of the heading or the tip', () => {
  const ids = parseCursorModels(LISTED);
  expect(ids.filter((id) => id.startsWith('Available') || id.startsWith('Tip'))).toEqual([]);
  expect(ids).toHaveLength(5);
});

// A binary that answered nothing, or answered something else, leaves no models. The spawn turns an
// empty list into the sentence that says how to repair it.
it.each(['', 'cursor-agent: command not found', '{"models":[]}'])('gives no models for %j', (text) => {
  expect(parseCursorModels(text)).toEqual([]);
});

// A real executable, so `--list-models` is read the way the binary answers it and the cache below is
// proved against a process and not a stand-in. It starts as nothing at all, which is how a machine
// without Cursor answers, and it is filled in afterwards.
function stub(): { path: string; fill: (text: string) => void; remove: () => void } {
  const made = stubBinary(`process.stdout.write(require('node:fs').readFileSync(__filename + '.models', 'utf8'));`, 'cursor-list-stub');
  return {
    path: made.path,
    fill: (text: string) => {
      writeFileSync(`${made.path}.models`, text);
      chmodSync(made.path, 0o755);
    },
    remove: made.remove,
  };
}

// The list is a network call, and the board reads it on every snapshot. A login or a line that does
// not answer costs the whole ten second timeout, so the empty answer is kept for a moment as well.
// Without that, every page load while the line is down would wait those ten seconds again.
it('does not ask a second time straight after an empty answer', () => {
  const binary = stub();
  try {
    expect(cursorModels(binary.path, process.env)).toEqual([]);
    binary.fill('composer-2.5 - Composer 2.5\n');
    expect(cursorModels(binary.path, process.env)).toEqual([]);
  } finally {
    binary.remove();
  }
});

// The list is what one login may run. Two Cursor logins on one machine answer with two lists, so a
// run under the second must not be checked against the first one's models.
it('keeps a list per login and not per binary', () => {
  const binary = stub();
  try {
    binary.fill('composer-2.5 - Composer 2.5\n');
    expect(cursorModels(binary.path, { ...process.env, CURSOR_CONFIG_DIR: '/tmp/login-a' })).toEqual(['composer-2.5']);
    binary.fill('kimi-k2.7-code - Kimi K2.7 Code\n');
    expect(cursorModels(binary.path, { ...process.env, CURSOR_CONFIG_DIR: '/tmp/login-b' })).toEqual(['kimi-k2.7-code']);
    // And the first login keeps its own answer, which is what the cache is for.
    expect(cursorModels(binary.path, { ...process.env, CURSOR_CONFIG_DIR: '/tmp/login-a' })).toEqual(['composer-2.5']);
  } finally {
    binary.remove();
  }
});
