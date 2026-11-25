// Scout and Evidence wait for a later version. Their code stays and keeps its tests, and this one
// switch hides every way into them: the rail draws no row for either, their keys, palette rows,
// toasts and settings go, their pages send a person to Now and their endpoints answer 404. True
// brings all of it back. It is no plan check (AGENTS.md rule 2): every plan gets the same answer.
export const SCOUT_AND_EVIDENCE = false;

// Accounts, the hosted server and the hubs wait for the paid plans. While this is false the client
// contacts no Nolzu host: no hub dial, no display document, no keychain read for an account, and
// `login`, `logout` and `status` print one sentence. The code stays and keeps its tests. True brings it
// back. Like the switch above it is no plan check: every machine gets the same answer.
export const CLOUD_OPEN = false;
