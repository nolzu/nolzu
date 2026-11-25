# AGENTS.md

What this project is, and the rules for an agent working in it.

A recipe app with two services.

| Service | Path | What it does |
|---|---|---|
| api | `services/api` | Reads the recipe data and serves it on `/recipes` |
| web | `services/web` | One page that fetches the list and renders it |

The base branch is `main`. There is no remote, so nothing is ever pushed.

Run the tests with `node --test services/api/src/recipes/list.test.ts`. There is nothing to
install: every file is plain TypeScript or JavaScript that Node runs as it is.

Tickets live in `tickets/` as local tickets, with keys such as `APP-1`.

## Rules

- Plain TypeScript and JavaScript only. This project installs nothing, so do not add a
  dependency, a lockfile or a build step.
- Write the test first for anything that is a plain function, next to the file it covers.
- Run `node --test services/api/src/recipes/list.test.ts` before you finish.
- Keep the recipe data small. It is a fixture, not a real catalogue.
- Plain, short English in comments and commit messages. No em-dashes.
