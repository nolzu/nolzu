# Nolzu

Nolzu is a local-first kanban board where dragging a card one column forward starts an AI coding
agent on your own machine. It runs your agents in your own checkout and keeps its data on your
machine.

Start it from any folder with Node 22.16.0 or newer (on Node 23, 23.4.0 or newer):

```bash
npx nolzu@latest
```

`npx` downloads the newest version each time, so the same command is also how you update. It prints
the agent tools it found, its data folder and its address, and opens a browser. One Nolzu runs per
data folder, so a later start opens the one that runs. `npx nolzu@latest --help` lists the other
commands. You need git and at least one coding agent on your PATH. The repository README names the
three agents Nolzu works with.

Nolzu runs on macOS. Linux and WSL 2 start with a warning and are not tested yet, and native Windows
is refused at start.

Each phase can get its own MCP servers, from a list committed in `.nolzu/mcp-servers.json` with the
secrets in your OS keychain. A workspace's own skills in `.nolzu/skills` travel with git and reach
every engine.

For a fixed version, install it globally with `npm install -g nolzu` and start it with `nolzu`.
Update it with `npm install -g nolzu@latest`.

Docs: https://nolzu.com/docs. Source and bug reports: https://github.com/nolzu/nolzu
