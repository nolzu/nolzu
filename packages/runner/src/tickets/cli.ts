import { spawn } from 'node:child_process';
import { exitCode } from '../git/exec.ts';
import { loginShellPath } from '../select.ts';

/**
 * One spawn for the ticket CLIs, `gh` and `glab`.
 *
 * Both hold their own login, so neither adapter keeps a token of its own, and both print one whole
 * answer on stdout. The two conditions their adapters write down and cannot keep are kept here. The
 * arguments go to the process as an array and never through a shell, so a query document with
 * newlines and quotes arrives whole. The tool is looked up on the login shell's PATH, because a
 * process started outside a login shell does not find it on macOS.
 *
 * What is per tool stays per tool: the exit code that means "no login" is read by the caller, and
 * every sentence below is built from the tool's own name and the host it talks to.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (args: readonly string[], signal: AbortSignal) => Promise<CliResult>;

// The tool prints the whole answer at once, so without a cap it all lands in memory first. GitHub
// allows 65,536 characters in an issue body, so a `gh` document of twenty issues stays well inside
// this. It is not proven for GitLab: a description may hold a megabyte, so thirty of them can pass
// this cap, which is why the sentence below names something the person can do instead of claiming the
// state cannot happen.
// Limit: one cap for every call of both tools. Give GitLab a cap of its own when a real project
// trips this one.
const MAX_STDOUT = 4_000_000;

export interface CliOptions {
  // The binary, as it is found on the PATH.
  bin: string;
  // The host as a person names it, for the sentences below.
  system: string;
  // The whole sentence about a machine that has no such tool, because the two are installed from
  // different places.
  install: string;
  // What to do about an answer over the cap. Per tool, because the two adapters read different things:
  // `gh` reads one issue for one card, and `glab` reads a page of a project's issues.
  cut: string;
  // The PATH the tool is looked up on. The login shell's by default, and a test's own folder in a test.
  path?: () => string;
  maxStdout?: number;
}

export function cliRunner(options: CliOptions): RunCli {
  const { bin, system, install, cut: advice } = options;
  const max = options.maxStdout ?? MAX_STDOUT;

  return (args, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(`The ${system} read was stopped before it started, so nothing was read.`));
        return;
      }

      const path = options.path === undefined ? loginShellPath(process.env) : options.path();
      // An array, and no shell. A query document holds newlines, braces and quotes, and a shell
      // would take them apart.
      const child = spawn(bin, [...args], {
        env: { ...process.env, PATH: path },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });

      let stdout = '';
      let stderr = '';
      let cut = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length >= max) {
          cut = true;
          child.kill();
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (signal.aborted) {
          reject(new Error(`${bin} did not answer in time, so nothing was read from ${system}.`));
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new Error(`${bin} is not on the PATH, so Nolzu cannot read ${system}. ${install}`));
          return;
        }
        reject(error);
      });

      child.on('close', (code, killedBy) => {
        // A cut answer is half a document. Handing it on would read as the host sending something
        // nobody can parse, and the person would try again forever.
        if (cut) {
          reject(new Error(`${system} sent more than ${max} characters for one read, so the answer was dropped. ${advice}`));
          return;
        }
        resolve({ code: exitCode(code, killedBy), stdout, stderr });
      });
    });
}
