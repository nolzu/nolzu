# Contributing

Start with the [README](README.md). It says what Nolzu is and how to run it. `AGENTS.md` holds
every rule for this repository, for people and for coding agents alike. This page covers what a
pull request needs.

Report a security problem by email, never in a public issue. [SECURITY.md](SECURITY.md) says how.

## Before you write code

A code pull request needs an issue that the maintainer labelled `accepted`. Open an issue first,
with a short plan, and wait for that label. Docs and typo fixes are welcome from anyone without an
issue. Any other pull request is closed with a kind note that asks for an issue first. A pull
request does one thing. Two small pull requests are easier to review than one large one.

## Sign off every commit

The contributor agreement is not ready yet. Until it is, every commit in your pull request carries
a sign-off line, `Signed-off-by: Your Name <you@example.com>`, which `git commit -s` adds. With
that line you state that you wrote the change, or have the right to give it under the repository
license, as the [Developer Certificate of Origin](https://developercertificate.org) says. To add
it to commits you already made, run `git commit --amend -s` for the last one, or
`git rebase --signoff main` for every commit on your branch, then push again with
`git push --force-with-lease`.

You keep the copyright of your lines, and they come in under the repository license. Once the
agreement is ready, new pull requests sign it, and earlier authors are asked once.

## Set up

You need Node 24.21.0 or newer to work on Nolzu (`.nvmrc` has the exact version), git, and pnpm
through corepack. Nolzu itself runs on Node 22.16.0 or newer.
`corepack pnpm` runs the pnpm version that `package.json` pins. If your Node has no `corepack`
command, install it with `npm install --global corepack`. The checks need no coding agent,
because the tests and the smoke run use a fake engine.

```bash
corepack pnpm install
corepack pnpm build
```

## The checks

CI runs these on every pull request, in this order. Run them before you push:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
NOLZU_FAKE_AGENT=1 corepack pnpm smoke
corepack pnpm build
corepack pnpm pack:check
corepack pnpm skills:lint
```

`lint` also checks the import boundaries between the packages, and `AGENTS.md` explains them.
`build` is a separate check from `typecheck`. `core` and `protocol` build with their own
`tsconfig.build.json` and the app builds with Vite, so a build can fail on a name the root
typecheck resolved. `pack:check` needs the build. It packs the app as the `nolzu` npm package,
installs it with `npm install -g` into an empty prefix with no registry, and starts it on the fake
engine through the `nolzu` link. Then it starts it a second time and checks that the second start
opens the first and exits 0. No real browser opens. `corepack pnpm pack:check --release` is the check
before a publish: it also fails while the version is `0.0.0` or the build prints a `-dev` version.

CI then runs two more checks. The first fails on an en dash or an em dash in any tracked `.md`,
`.svelte` or `.html` file. Run it yourself with the command below. `--untracked` also reads the
new files you have not added yet.

```bash
git grep --untracked -n -E "$(printf '\342\200\223|\342\200\224')" -- '*.md' '*.svelte' '*.html'
```

The second is a [gitleaks](https://github.com/gitleaks/gitleaks) scan over the whole git history.
With gitleaks installed, `gitleaks git` runs the same scan. A secret in any commit of your branch
fails it, even after a later commit removes the secret. Revoke the secret, then take it out of
your branch's history before you push again.

Run vitest from the repository root, also for one file, because the root config sets up every
package:

```bash
corepack pnpm exec vitest run packages/core/src/board.test.ts
```

The tests point `HOME` and the data folder at a temporary folder, so they never touch your real
`~/.nolzu`. A test that reaches the real data folder fails on purpose.

## Release steps

Publishing `nolzu` is the maintainer's step, never CI's. pnpm packs it, because pnpm puts the
license in and turns the `workspace:` ranges into versions, and npm publishes those exact bytes.

1. Set `version` in `apps/local/package.json`, and give the `CHANGELOG.md` section of that version
   its date.
2. Commit, and tag that commit `v<version>`. The build reads the tag, so it comes first.
3. From a clean clone of the tag: `corepack pnpm install --frozen-lockfile`, then
   `corepack pnpm build`.
4. `corepack pnpm pack:check --release`.
5. In `apps/local`, `corepack pnpm pack`, which writes `nolzu-<version>.tgz`.
6. Try that tarball: install it with `npm install -g` into a scratch prefix with a scratch `HOME`,
   start it, and check that `nolzu --version` prints `nolzu <version>`.
7. From the root of the clone, `node apps/local/scripts/release-check.ts`. For a prerelease, run
   `npm_config_tag=next node apps/local/scripts/release-check.ts`. It must print nothing and
   exit 0.
8. `npm publish nolzu-<version>.tgz`. A prerelease such as `0.2.0-rc.1` takes `--tag next`, so
   `npx nolzu@latest` keeps the last release.

`npm publish` of a tarball runs no scripts of the package, so its `prepublishOnly` does not run
there. Step 7 runs the same check by hand: it refuses a placeholder or development version, a
prerelease on `latest`, a build that prints another version, and any publish from CI.

## No real names

Do not put real names in the repository. That means no names of your employer, its customers or
your colleagues, no internal hostnames or URLs, no real ticket keys and no paths from your own
machine. The rule covers code, tests, fixtures, docs, screenshots and commit messages. The tools
Nolzu works with, such as GitHub or Claude Code, are fine to name.

Use `PROJ-123` as the example key for an outside ticket system, and `APP-1` and up for local
tickets. The demo project is a recipe app. The licensor and the copyright line in `LICENSE` are
one exception. The other is a bundled font license kept as its authors wrote it, such as
`packages/ui/src/fonts/OFL.txt`. Search your diff for names before you push.

## Writing

Docs, code comments, UI text, commit messages and pull requests follow the same rules. Many
readers are not native English speakers.

- Plain, short English. One idea per sentence.
- No em dash and no en dash. Use a comma, a period or parentheses.
- None of these words: "delve", "leverage", "robust", "seamless", "elevate", "unlock",
  "comprehensive", "ensure that".
- No filler words: "just", "really", "basically", "actually", "simply", "in order to".
- No bold title sentence at the start of a paragraph or a list item.
- Prose by default. A list is only for more than two parallel items.
- UI text names the problem. Never "Something went wrong" or "Oops".
- Code comments say why, not what.
- Commit messages use `type(scope): subject`, in the imperative, 72 characters or less.
- A pull request description says what changed, why when the title does not say it, and how to
  test it. The pull request template asks for these.
- No generated-by lines, no tool attribution and no co-author trailers. The one place to name the
  AI tools that helped is the "AI tools" part of the pull request template.

The license is FSL-1.1-ALv2, so call the project "source available" or "public source".

## When a pull request is ready

All the checks above pass, every commit is signed off, and new behaviour has tests. A pure module gets its tests written
first. When a change alters behaviour or setup, the README and the docs say so in the same pull
request. The rules in `AGENTS.md` hold as well: for example, no paid logic in this repository,
and no secret anywhere but the OS keychain.
