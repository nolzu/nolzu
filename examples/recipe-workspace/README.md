# Recipe workspace

The demo project. Docs and tests run against this folder, so it has to stay small, offline
and boring.

Two services. `services/api` holds the recipe list and a small HTTP server. `services/web`
is one page that fetches the list and renders it. Both are plain TypeScript and JavaScript
that Node runs directly, so there is nothing to install and no lockfile.

```
node --test services/api/src/recipes/list.test.ts
node services/api/src/server.ts
```

There is no `.git` folder here, because a git repository cannot sit inside another one and
still be committed. A run that needs a repository copies this folder to a temp directory and
runs `git init` there, so the files in the repository are never touched.

`tickets/` holds the work as local tickets, the kind Nolzu uses when a project has no ticket
system. `APP-1` is the one the demo follows.
