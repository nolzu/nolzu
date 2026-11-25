// The models Claude Code offers, kept by hand. The engine has no command that lists the models an
// account may use, and `/model` is an interactive picker, so a model that vanished shows as gone only
// after a run refuses it. `fable`, `opus` and `sonnet` are the aliases the `--help` of 2.1.278 names,
// and `haiku` is the one the presets use for refine. docs/engines/claude-code.md keeps the list.
//
// Aliases, which the CLI maps to its newest model of that family, because the presets name aliases.
// The engine design moves to concrete ids with the model list per engine. What is out already:
// `default` and `opusplan`, which pick or switch the model inside one run, so the card would show one
// model and the run would use another.
const CLAUDE_MODELS: readonly string[] = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

export function claudeModels(): readonly string[] {
  return CLAUDE_MODELS;
}
