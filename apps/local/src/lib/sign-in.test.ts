import { expect, it } from 'vitest';
import { signInLine } from './sign-in.ts';

it('puts the folder in the variable for one command', () => {
  expect(signInLine('claude auth login', 'CLAUDE_CONFIG_DIR', '~/.claude-work')).toBe('CLAUDE_CONFIG_DIR=~/.claude-work claude auth login');
  expect(signInLine('codex login', 'CODEX_HOME', '/home/you/.codex-work')).toBe('CODEX_HOME=/home/you/.codex-work codex login');
});

// An empty folder is the tool's own default place.
it('gives the bare command for no folder', () => {
  expect(signInLine('codex login', 'CODEX_HOME', '  ')).toBe('codex login');
});

it('quotes a folder with a space or a quote, and keeps ~ where the shell reads it', () => {
  expect(signInLine('codex login', 'CODEX_HOME', '~/Dev Codex')).toBe("CODEX_HOME=~/'Dev Codex' codex login");
  expect(signInLine('codex login', 'CODEX_HOME', "/home/you/it's")).toBe("CODEX_HOME='/home/you/it'\\''s' codex login");
});

