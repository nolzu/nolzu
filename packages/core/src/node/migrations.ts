// Plain strings, so the migrations bundle and publish with the code. Each entry runs once,
// in order. Never change a released entry. Append a new one.
export const migrations: readonly string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  ) STRICT;

  CREATE TABLE cards (
    key TEXT PRIMARY KEY,
    board TEXT NOT NULL,
    stage TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle',
    title TEXT NOT NULL,
    summary TEXT,
    extra_context TEXT,
    models_json TEXT,
    minimized INTEGER NOT NULL DEFAULT 0,
    assignee TEXT
  ) STRICT;

  CREATE TABLE card_events (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    who TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    started_phase TEXT
  ) STRICT;

  CREATE INDEX card_events_card_key ON card_events (card_key);

  -- No foreign key on card_key: a run can belong to a pseudo-ticket that has no card row.
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL,
    phase TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    session_id TEXT,
    tokens INTEGER,
    cost_estimate REAL,
    duration_ms INTEGER,
    log_path TEXT,
    error TEXT,
    result TEXT
  ) STRICT;

  CREATE INDEX runs_card_key ON runs (card_key);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE seq (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) STRICT;
  `,
  `
  -- The run row could not answer what the agents drawer and the phase strip ask: which
  -- state a run is in, which lane it holds, when it started and ended, and what it asked.
  ALTER TABLE runs ADD COLUMN state TEXT;
  ALTER TABLE runs ADD COLUMN lane TEXT;
  ALTER TABLE runs ADD COLUMN started_at TEXT;
  ALTER TABLE runs ADD COLUMN ended_at TEXT;
  ALTER TABLE runs ADD COLUMN question TEXT;
  ALTER TABLE runs ADD COLUMN attempt INTEGER;
  ALTER TABLE runs ADD COLUMN plain_summary TEXT;

  -- A run reports four token counts and a cache read costs a fraction of an input token,
  -- so one total cannot produce an honest cost report. The old column goes, because two
  -- sources of truth would drift apart.
  ALTER TABLE runs ADD COLUMN tokens_input INTEGER;
  ALTER TABLE runs ADD COLUMN tokens_output INTEGER;
  ALTER TABLE runs ADD COLUMN tokens_cache_read INTEGER;
  ALTER TABLE runs ADD COLUMN tokens_cache_creation INTEGER;
  ALTER TABLE runs DROP COLUMN tokens;

  -- Where the card came from. Everything that existed before this migration was typed by
  -- hand, which is what a local ticket is.
  ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE cards ADD COLUMN source_ref TEXT;

  -- Undirected, so the pair is stored once in a fixed order and the check refuses the
  -- mirror image. That also refuses a card linked to itself, and it makes the primary key
  -- enough to keep one row per pair. No reason column: "same parent" is computed when the
  -- Add card dialog previews it, and is not a fact worth storing.
  CREATE TABLE card_links (
    a TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    b TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    PRIMARY KEY (a, b),
    CHECK (a < b)
  ) STRICT;

  -- The primary key already covers a lookup by a, and this covers the other direction.
  CREATE INDEX card_links_b ON card_links (b);
  `,
  `
  -- One writer per data directory. Two schedulers on one folder would both claim the same cards and
  -- start the same run twice, and sqlite's own lock does not prevent that: it serialises writes, it
  -- does not say who owns the queue. One row only, which the check pins.
  CREATE TABLE writer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  `,
  `
  -- The discussion. One thread per phase, one per review action, and one "ask" thread that belongs
  -- to no phase. The thread column holds the phase id, the review ref or the word ask, so a new
  -- kind of thread needs no column.
  --
  -- run_id is the run a message belongs to: the agent message it came from, or for a person's
  -- message the run whose session it continued. Null for a message typed before anything ran,
  -- which the ask thread allows.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    thread TEXT NOT NULL,
    -- who wrote it: person or agent. Not a boolean, because a third writer arrives with the hubs.
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL,
    run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL
  ) STRICT;

  -- Every read is one card's one thread, in order.
  CREATE INDEX messages_card_thread ON messages (card_key, thread, id);
  `,
  `
  -- One row per knowledge file a run touched. Every row of one run carries the same commit, because
  -- one run is one commit, while the Knowledge screen asks per file: who taught this file, what
  -- changed in it, and revert this one path.
  --
  -- No foreign key on card_key: a knowledge maintenance run belongs to no card and carries the
  -- reserved key kb-maintenance, the same way a pseudo-ticket run does in the runs table.
  --
  -- commit_sha is null while a change waits for review, because there is no commit yet. status is
  -- applied, reverted or pending, and the check refuses a fourth word rather than letting the
  -- screen meet one it cannot draw.
  CREATE TABLE knowledge_changes (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    commit_sha TEXT,
    summary TEXT,
    status TEXT NOT NULL CHECK (status IN ('applied', 'reverted', 'pending'))
  ) STRICT;

  -- The two reads the Knowledge screen makes: one file's history, and one run's whole change.
  CREATE INDEX knowledge_changes_file ON knowledge_changes (file_path, id);
  CREATE INDEX knowledge_changes_run ON knowledge_changes (run_id);
  `,
  `
  -- What a QA run decided, and how its stack ended. Both belong to the run and not to the card: a
  -- card checked twice has two verdicts, and the ticket page shows each run its own.
  --
  -- verdict is PASS, FAIL or BLOCKED, and null when the run printed no verdict line at all, which
  -- is not a pass. verdict_reason carries the sentence either way, so a run with no verdict can
  -- still say why the card was left for a person.
  ALTER TABLE runs ADD COLUMN verdict TEXT;
  ALTER TABLE runs ADD COLUMN verdict_reason TEXT;

  -- The stack the run was checked against: off, up or failed, with the command's own words when
  -- there are any. A stack that would not come up stops the run, and an unload that failed leaves
  -- the stack up and says so.
  ALTER TABLE runs ADD COLUMN stack_state TEXT;
  ALTER TABLE runs ADD COLUMN stack_reason TEXT;
  `,
  `
  -- Review adds two things a change row has to carry: the status returned, for a change a person
  -- sent back instead of applying, and the note they wrote with it. sqlite cannot widen a CHECK,
  -- so the table is rebuilt with the new word in it and the rows are copied over.
  --
  -- note belongs to the return. Every row of a returned run carries the same sentence, because a
  -- person returns one run's change and the next wrap-up of that card reads that sentence in its
  -- prompt.
  CREATE TABLE knowledge_changes_next (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL,
    run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    commit_sha TEXT,
    summary TEXT,
    status TEXT NOT NULL CHECK (status IN ('applied', 'reverted', 'pending', 'returned')),
    note TEXT
  ) STRICT;

  INSERT INTO knowledge_changes_next (id, card_key, run_id, file_path, commit_sha, summary, status)
    SELECT id, card_key, run_id, file_path, commit_sha, summary, status FROM knowledge_changes;

  DROP TABLE knowledge_changes;
  ALTER TABLE knowledge_changes_next RENAME TO knowledge_changes;

  CREATE INDEX knowledge_changes_file ON knowledge_changes (file_path, id);
  CREATE INDEX knowledge_changes_run ON knowledge_changes (run_id);
  `,
  `
  -- The stack of this card as Nolzu last saw it. The two run columns above are the audit trail of
  -- one QA run and stay that. These two are the live state the stack panel reads, and the Load,
  -- Unload and Force buttons write, because a person can take a stack up or down with no run going.
  ALTER TABLE cards ADD COLUMN stack_state TEXT;
  ALTER TABLE cards ADD COLUMN stack_reason TEXT;
  `,
  `
  -- Where Scout looks. One row per source a person added, with the adapter's own settings as JSON
  -- and never a secret in it: a credential goes to the OS keychain under its own name and nothing
  -- of it reaches this file.
  CREATE TABLE scout_sources (
    id INTEGER PRIMARY KEY,
    -- Which adapter fetches it. The four Scout ships, mirroring the union in protocol.
    kind TEXT NOT NULL CHECK (kind IN ('paste', 'tickets', 'sentry', 'search')),
    -- What the person typed, so two sources of one kind are told apart on the screen.
    label TEXT NOT NULL,
    -- The adapter's own settings. A secret never goes in here, and the module that writes this
    -- column is the one place that says so.
    config_json TEXT NOT NULL DEFAULT '{}',
    -- A source turned off keeps its row and its cursor, so turning it on again does not replay
    -- everything it has already seen.
    enabled INTEGER NOT NULL DEFAULT 1,
    -- The two opt-ins, both off until a person turns them on. A source
    -- that made cards or started runs the moment it was added would act before anybody agreed.
    create_cards INTEGER NOT NULL DEFAULT 0,
    auto_assess INTEGER NOT NULL DEFAULT 0,
    -- Where the last fetch stopped, as the adapter writes it. A person reads it on the screen, so
    -- it is short text and not an opaque blob.
    cursor TEXT,
    last_checked TEXT,
    -- What the last check failed with, in the source's own words. Null once one succeeds.
    last_error TEXT
  ) STRICT;
  `,
  `
  -- What Scout found: one row per event, never one per occurrence. dedup folds a fetch into the
  -- handful of events behind it before anything is stored, which is why there is no items table.
  -- The two message columns below are the evidence a person reads on the detail.
  CREATE TABLE scout_findings (
    id INTEGER PRIMARY KEY,
    -- The cascade is the whole delete. A finding whose source is gone can never be checked again,
    -- and PRAGMA foreign_keys is on, so no application code has to remember this.
    source_id INTEGER NOT NULL REFERENCES scout_sources (id) ON DELETE CASCADE,
    -- The id one event keeps across its occurrences, as fingerprint writes it.
    fingerprint TEXT NOT NULL,
    -- The four finding kinds. This is the finding's kind and not the source's: one
    -- paste can hold a bug and an insight. A new finding is a bug until somebody says otherwise.
    kind TEXT NOT NULL DEFAULT 'bug' CHECK (kind IN ('bug', 'regression', 'improvement', 'insight')),
    -- The five open columns of the findings board and the two collapsed ones. All seven words are
    -- in the check although this version only ever writes new: sqlite cannot widen a CHECK, and
    -- migration 7 above is what one more word costs once there are rows, a whole table rebuilt and
    -- copied over.
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assess', 'decide', 'started', 'done', 'parked', 'dismissed')),
    -- Over every check this finding was met in, not in the last one. A check adds what its fetch
    -- counted.
    occurrences INTEGER NOT NULL DEFAULT 0,
    -- When the event opened this row, and when it was last met. first_seen is never moved again, so
    -- the detail can say how long the problem has been going on.
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    -- The evidence: the line as it was pasted, for the first occurrence and for the newest one. Both
    -- are kept because the fingerprint reads past the ids and the numbers, so those two lines differ
    -- exactly where a person needs to see that they differ. Whatever was pasted is in this file.
    first_message TEXT NOT NULL,
    last_message TEXT NOT NULL,
    -- Where the event happens. It is part of the fingerprint, so every occurrence of one finding
    -- names the same place and this column never moves. Empty where the source names no place, and
    -- pasted text names none.
    location TEXT NOT NULL DEFAULT '',
    -- The card this finding became, once a person accepts it. No foreign key, for the reason the
    -- runs table gives: the key can name a pseudo-ticket that has no card row.
    card_key TEXT,
    -- One finding per event per source. Two sources that see the same line get one finding each,
    -- because the same problem in two places is two things to fix. The index this makes is also the
    -- one a read of a source's findings uses, so no second index is needed.
    UNIQUE (source_id, fingerprint)
  ) STRICT;
  `,
  `
  -- The pull request a card on the PR reviews board was made from. The title and the key are the
  -- card's own columns already, and the review round is not here: the review writes it in the
  -- card's folder, and no review runs yet.
  ALTER TABLE cards ADD COLUMN pr_author TEXT;
  -- APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED. Null on every card that is not a pull request,
  -- which is what tells the two apart: a pull request always has one of the three words. The check
  -- holds all three, because sqlite cannot add one to a column later without rebuilding the table.
  ALTER TABLE cards ADD COLUMN pr_decision TEXT CHECK (pr_decision IN ('APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'));
  -- When the head commit was made, so the board can say how old the code under review is.
  ALTER TABLE cards ADD COLUMN pr_head_at TEXT;
  ALTER TABLE cards ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The ticket a finding is about, for a finding a ticket query found. The key itself and not a
  -- flag, because the card a person starts from such a finding is that ticket and takes its key.
  -- Null on every other finding. It cannot be read off the location column: a ticket writes its key
  -- there and a failed CI run writes repo@branch into the same one, so nothing told the two apart.
  ALTER TABLE scout_findings ADD COLUMN external_key TEXT;
  `,
  `
  -- How often Nolzu cloud checks this source, in minutes, and whether a new finding notifies the
  -- person. Columns of the source and not a settings row, because a removed source has to take its
  -- schedule with it and the row already cascades. Zero is off, which is what every source starts
  -- as: a schedule runs on the server, and no source may start costing the person money by itself.
  ALTER TABLE scout_sources ADD COLUMN schedule_minutes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scout_sources ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Whether the pull request of a card is still open, written when the board reads its repository
  -- again. The card stays on the board after its pull request closed and says so, because a review in
  -- progress is still worth reading. Null on every card that is not a pull request, and on one made
  -- before this column, which was open when it was made. All three words are in the check, because
  -- sqlite cannot widen one later without rebuilding the table.
  ALTER TABLE cards ADD COLUMN pr_state TEXT CHECK (pr_state IN ('open', 'closed', 'merged'));
  `,
  `
  -- The Merge column is gone, so a Delivery card standing on merge would stand on no column. PR watch is
  -- the stage the pull request flow has at that place, and the card's branch is merged already, so it
  -- waits there for a person to drag it on to wrap-up. The board filter keeps any other board's
  -- stage of the same name where it is.
  UPDATE cards SET stage = 'pr-watch' WHERE board = 'delivery' AND stage = 'merge';
  `,
  `
  -- The repositories a card works in, as a JSON list of the paths in the project's repos setting, and
  -- who set the list. Refine and plan pick it, and a person can change it, which wins over both. Null
  -- on every card made before, which on a project with one repository means that repository.
  ALTER TABLE cards ADD COLUMN repos TEXT;
  ALTER TABLE cards ADD COLUMN repos_by TEXT CHECK (repos_by IN ('refine', 'plan', 'person'));
  `,
  `
  -- The folder a run started in. An engine files a session under that folder, so a resume has to
  -- start there too. Refine and plan on several repositories start in the project folder until the
  -- card has a root, and only this column says which one a session was made in. Null on every run
  -- made before.
  ALTER TABLE runs ADD COLUMN cwd TEXT;
  `,
  `
  -- The knowledge folder a change was committed in, written when a project of one repository becomes a
  -- workspace and its knowledge moves to the workspace's own folder. The commit stays in the old
  -- folder, so Revert cannot act on it here. Null on every change made in the folder in use now.
  ALTER TABLE knowledge_changes ADD COLUMN moved_from TEXT;
  `,
  `
  -- The time trackers a week of the timesheet is sent to, one row per destination. The token is not
  -- here. It is in the OS keychain under export-<destination>, so this row can be listed and drawn
  -- without asking the person for their keychain password.
  CREATE TABLE exporters (
    destination TEXT PRIMARY KEY CHECK (destination IN ('toggl', 'harvest', 'clockify', 'jira')),
    -- The ids the destination needs, such as a workspace, as a JSON object. Never the token.
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_export_at TEXT,
    -- What the last export stopped on or failed with, in the destination's words. Null once one
    -- export had nothing go wrong.
    last_error TEXT
  ) STRICT;

  -- Every entry an export tried, per destination, keyed by the external id the timesheet built. A row
  -- with sent_at is never posted again, so a second press of Export writes nothing new. No foreign key
  -- to exporters: a removed connection keeps these rows, so connecting the tracker again does not
  -- bill the same week twice.
  CREATE TABLE export_entries (
    destination TEXT NOT NULL,
    -- nolzu:<project id>:<card>:<day>, with no figure in it, so a day that changed keeps its id.
    external_id TEXT NOT NULL,
    day TEXT NOT NULL,
    -- The minutes that went out, which stay as they were billed when the week changes after.
    minutes INTEGER NOT NULL,
    sent_at TEXT,
    -- The id the destination gave the entry, so a person can follow one row to the other system.
    remote_id TEXT,
    -- Failed tries. Past five the entry is left alone with the sentence it last failed with.
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (destination, external_id)
  ) STRICT;
  `,
  `
  -- A card made from a GitHub issue is keyed repo#n, like a pull request card, so it names a folder
  -- and can run. A card keyed owner/repo#n moves to repo#n with every row that names it, and its full
  -- name stays as its source ref. A card whose new key another card holds stays on its old key, where
  -- it cannot run, as before: nothing is merged and nothing is lost. A GitLab key has the same shape,
  -- group/project#n, so the rows are picked by where they came from and never by the shape of a key.
  PRAGMA defer_foreign_keys = ON;

  -- json_valid first, because json_extract throws on a config written by hand, and a throw here would
  -- stop the app from opening.
  CREATE TEMP TABLE github_sources AS
    SELECT id FROM scout_sources
    WHERE kind = 'tickets' AND CASE WHEN json_valid(config_json) THEN json_extract(config_json, '$.system') END = 'github';

  -- Add card writes source github for an issue and nothing else. A card Scout started is external, and
  -- a finding of a GitHub source names it. A card whose source was removed cannot be told apart from a
  -- GitLab one any more, so it stays.
  CREATE TEMP TABLE issue_keys (old TEXT PRIMARY KEY, new TEXT NOT NULL);
  INSERT INTO issue_keys (old, new)
    SELECT key, substr(key, instr(key, '/') + 1) FROM cards
    WHERE key GLOB '*/*#[0-9]*' AND key NOT GLOB '*/*/*'
      AND (source = 'github' OR (source = 'external' AND key IN (SELECT card_key FROM scout_findings WHERE source_id IN (SELECT id FROM github_sources))));
  -- A new key another card holds, and the second of two cards that would land on one key. Two owners'
  -- repositories of one name meet here.
  DELETE FROM issue_keys WHERE new IN (SELECT key FROM cards);
  DELETE FROM issue_keys WHERE old NOT IN (SELECT min(old) FROM issue_keys GROUP BY new);

  UPDATE cards SET key = (SELECT new FROM issue_keys WHERE old = cards.key) WHERE key IN (SELECT old FROM issue_keys);
  UPDATE card_events SET card_key = (SELECT new FROM issue_keys WHERE old = card_events.card_key) WHERE card_key IN (SELECT old FROM issue_keys);
  UPDATE messages SET card_key = (SELECT new FROM issue_keys WHERE old = messages.card_key) WHERE card_key IN (SELECT old FROM issue_keys);
  UPDATE runs SET card_key = (SELECT new FROM issue_keys WHERE old = runs.card_key) WHERE card_key IN (SELECT old FROM issue_keys);
  UPDATE knowledge_changes SET card_key = (SELECT new FROM issue_keys WHERE old = knowledge_changes.card_key) WHERE card_key IN (SELECT old FROM issue_keys);
  UPDATE scout_findings SET card_key = (SELECT new FROM issue_keys WHERE old = scout_findings.card_key) WHERE card_key IN (SELECT old FROM issue_keys);
  -- A link is stored once with a before b, and the new key can sort the other way. SET reads the old
  -- row on both sides, so one statement puts the pair back in order.
  UPDATE card_links SET
    a = min(coalesce((SELECT new FROM issue_keys WHERE old = card_links.a), a), coalesce((SELECT new FROM issue_keys WHERE old = card_links.b), b)),
    b = max(coalesce((SELECT new FROM issue_keys WHERE old = card_links.a), a), coalesce((SELECT new FROM issue_keys WHERE old = card_links.b), b))
  WHERE a IN (SELECT old FROM issue_keys) OR b IN (SELECT old FROM issue_keys);
  -- The card key sits encoded inside the export id, nolzu:<project>:<card>:<day>. A GitHub name holds
  -- no character the encoding changes but the slash and the hash.
  UPDATE export_entries SET external_id = replace(external_id, ':' || replace(replace(m.old, '/', '%2F'), '#', '%23') || ':', ':' || replace(m.new, '#', '%23') || ':')
    FROM issue_keys AS m
    WHERE instr(export_entries.external_id, ':' || replace(replace(m.old, '/', '%2F'), '#', '%23') || ':') > 0;

  -- The dedup key of a GitHub ticket finding is its key, so it moves too, or the next check would make
  -- a second finding for every ticket. An owner renamed, or a repository moved to another owner, left
  -- two findings for one repo#n. The one last seen is the live one and moves. The other keeps its old
  -- key and is never met again.
  CREATE TEMP TABLE issue_findings AS
    SELECT id, new FROM (
      SELECT id, 'tickets:' || substr(fingerprint, instr(fingerprint, '%2F') + 3) AS new,
        row_number() OVER (PARTITION BY source_id, substr(fingerprint, instr(fingerprint, '%2F') + 3) ORDER BY last_seen DESC, id DESC) AS place
      FROM scout_findings
      WHERE source_id IN (SELECT id FROM github_sources) AND fingerprint GLOB 'tickets:*%2F*%23*')
    WHERE place = 1;
  -- OR IGNORE all the same, so a row that holds the new key already cannot stop the app from opening.
  UPDATE OR IGNORE scout_findings SET
    fingerprint = (SELECT new FROM issue_findings WHERE id = scout_findings.id),
    external_key = CASE WHEN external_key GLOB '*/*' THEN substr(external_key, instr(external_key, '/') + 1) ELSE external_key END,
    location = CASE WHEN location GLOB '*/*#*' THEN substr(location, instr(location, '/') + 1) ELSE location END
  WHERE id IN (SELECT id FROM issue_findings);
  -- The cursor is what the last check reported, ids with a space between them. Left as it was, the
  -- next check would meet every ticket on the page again. A ci:<run> id holds no slash and stays.
  -- Sorted again, the way a check writes it, because a stripped owner can change the order.
  UPDATE scout_sources SET cursor = (
    SELECT group_concat(id, ' ' ORDER BY id) FROM (
      SELECT CASE WHEN value GLOB '*/*' THEN substr(value, instr(value, '/') + 1) ELSE value END AS id
      FROM json_each('["' || replace(cursor, ' ', '","') || '"]')))
  WHERE id IN (SELECT id FROM github_sources) AND cursor GLOB '*/*' AND json_valid('["' || replace(cursor, ' ', '","') || '"]');

  DROP TABLE temp.issue_findings;
  DROP TABLE temp.issue_keys;
  DROP TABLE temp.github_sources;
  `,
  `
  -- A card Scout started from a GitLab issue is keyed project#n, the last part of the path, like a
  -- GitHub issue card, so it names a folder and can run. A card keyed group/project#n moves with every
  -- row that names it, and its full name stays as its source ref. A card whose new key another card
  -- holds stays on its old key, where it cannot run, as before. sqlite has no last instr, so the last
  -- part of x is substr(x, length(rtrim(x, replace(x, '/', ''))) + 1): the rtrim takes off every
  -- character after the last slash.
  PRAGMA defer_foreign_keys = ON;

  -- json_valid first, because json_extract throws on a config written by hand, and a throw here would
  -- stop the app from opening.
  CREATE TEMP TABLE ticket_sources AS
    SELECT id, json_extract(config_json, '$.system') AS system FROM scout_sources
    WHERE kind = 'tickets' AND CASE WHEN json_valid(config_json) THEN json_extract(config_json, '$.system') END IN ('github', 'gitlab');

  -- Three kinds of card. An external card a finding of a GitHub or a GitLab source names was started
  -- from that issue. An external card no finding names lost its source, so its system is unknown. Only
  -- Start on a GitHub or a GitLab issue wrote an external card with a slash. Both take the last part
  -- now, so the card moves all the same. A github card is an issue card the migration before this one
  -- left on a taken key, and it gets another try. A card a source of no known system names stays.
  CREATE TEMP TABLE slash_keys (old TEXT PRIMARY KEY, new TEXT NOT NULL);
  INSERT INTO slash_keys (old, new)
    SELECT key, substr(key, length(rtrim(key, replace(key, '/', ''))) + 1) FROM cards
    WHERE key GLOB '*/*#[0-9]*'
      AND (source = 'github' OR (source = 'external' AND (
        key IN (SELECT card_key FROM scout_findings WHERE source_id IN (SELECT id FROM ticket_sources))
        OR key NOT IN (SELECT card_key FROM scout_findings WHERE card_key IS NOT NULL))));
  -- A new key another card holds, and the second of two cards that would land on one key. A GitHub
  -- app#1 and a GitLab app#1 meet here, and so do two groups' projects of one name.
  DELETE FROM slash_keys WHERE new IN (SELECT key FROM cards);
  DELETE FROM slash_keys WHERE old NOT IN (SELECT min(old) FROM slash_keys GROUP BY new);

  UPDATE cards SET key = (SELECT new FROM slash_keys WHERE old = cards.key), source_ref = coalesce(source_ref, key) WHERE key IN (SELECT old FROM slash_keys);
  UPDATE card_events SET card_key = (SELECT new FROM slash_keys WHERE old = card_events.card_key) WHERE card_key IN (SELECT old FROM slash_keys);
  UPDATE messages SET card_key = (SELECT new FROM slash_keys WHERE old = messages.card_key) WHERE card_key IN (SELECT old FROM slash_keys);
  UPDATE runs SET card_key = (SELECT new FROM slash_keys WHERE old = runs.card_key) WHERE card_key IN (SELECT old FROM slash_keys);
  UPDATE knowledge_changes SET card_key = (SELECT new FROM slash_keys WHERE old = knowledge_changes.card_key) WHERE card_key IN (SELECT old FROM slash_keys);
  UPDATE scout_findings SET card_key = (SELECT new FROM slash_keys WHERE old = scout_findings.card_key) WHERE card_key IN (SELECT old FROM slash_keys);
  -- A link is stored once with a before b, and the new key can sort the other way.
  UPDATE card_links SET
    a = min(coalesce((SELECT new FROM slash_keys WHERE old = card_links.a), a), coalesce((SELECT new FROM slash_keys WHERE old = card_links.b), b)),
    b = max(coalesce((SELECT new FROM slash_keys WHERE old = card_links.a), a), coalesce((SELECT new FROM slash_keys WHERE old = card_links.b), b))
  WHERE a IN (SELECT old FROM slash_keys) OR b IN (SELECT old FROM slash_keys);
  -- The card key sits encoded inside the export id, nolzu:<project>:<card>:<day>. A GitLab path holds
  -- no character the encoding changes but the slash and the hash.
  UPDATE export_entries SET external_id = replace(external_id, ':' || replace(replace(m.old, '/', '%2F'), '#', '%23') || ':', ':' || replace(m.new, '#', '%23') || ':')
    FROM slash_keys AS m
    WHERE instr(export_entries.external_id, ':' || replace(replace(m.old, '/', '%2F'), '#', '%23') || ':') > 0;

  -- The dedup key of a GitLab ticket finding is its key, so it moves too, or the next check would make
  -- a second finding for every ticket. Read with its slashes put back, so the last part is found the
  -- same way. A project moved to another group left two findings for one project#n: the one last seen
  -- moves, and the other keeps its old key and is never met again. GitHub findings moved before.
  CREATE TEMP TABLE slash_findings AS
    SELECT id, 'tickets:' || substr(path, length(rtrim(path, replace(path, '/', ''))) + 1) AS new, source_id, last_seen FROM (
      SELECT id, source_id, last_seen, replace(fingerprint, '%2F', '/') AS path FROM scout_findings
      WHERE source_id IN (SELECT id FROM ticket_sources WHERE system = 'gitlab') AND fingerprint GLOB 'tickets:*%2F*%23*');
  DELETE FROM slash_findings WHERE id NOT IN (
    SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY source_id, new ORDER BY last_seen DESC, id DESC) AS place FROM slash_findings) WHERE place = 1);
  -- OR IGNORE, so a row that holds the new key already cannot stop the app from opening.
  UPDATE OR IGNORE scout_findings SET
    fingerprint = (SELECT new FROM slash_findings WHERE id = scout_findings.id),
    external_key = CASE WHEN external_key GLOB '*/*' THEN substr(external_key, length(rtrim(external_key, replace(external_key, '/', ''))) + 1) ELSE external_key END,
    location = CASE WHEN location GLOB '*/*#*' THEN substr(location, length(rtrim(location, replace(location, '/', ''))) + 1) ELSE location END
  WHERE id IN (SELECT id FROM slash_findings);
  -- The cursor is what the last check reported, ids with a space between them. Left as it was, the
  -- next check would meet every ticket on the page again. Sorted again, the way a check writes it.
  UPDATE scout_sources SET cursor = (
    SELECT group_concat(id, ' ' ORDER BY id) FROM (
      SELECT substr(value, length(rtrim(value, replace(value, '/', ''))) + 1) AS id
      FROM json_each('["' || replace(cursor, ' ', '","') || '"]')))
  WHERE id IN (SELECT id FROM ticket_sources WHERE system = 'gitlab') AND cursor GLOB '*/*' AND json_valid('["' || replace(cursor, ' ', '","') || '"]');

  DROP TABLE temp.slash_findings;
  DROP TABLE temp.slash_keys;
  DROP TABLE temp.ticket_sources;
  `,
  `
  -- 1 for a run that goes on from earlier work: an answer, a discussion message, a retry, a run told
  -- to go on from a progress file, or a run that waited out an API error. Its cost and time say
  -- nothing about a fresh start, so the estimates leave it out. Null on every row made before this column. No column kept says which kind of run
  -- it was, since session_id takes the engine's id at the end and a retry was written like a first
  -- run, so those rows are left out too rather than guessed.
  ALTER TABLE runs ADD COLUMN resumed INTEGER CHECK (resumed IN (0, 1));
  -- The model the run asked for. model takes what the engine reports at the end, a full id or a
  -- label, and the estimate is looked up by the name the start line shows.
  ALTER TABLE runs ADD COLUMN asked_model TEXT;
  `,
  `
  -- The answers a blocked run offered with its question, as a JSON list of label and meaning, read
  -- from the question file the run wrote. Null on a run that offered none and on every row made
  -- before this column, and the question then shows as plain text.
  ALTER TABLE runs ADD COLUMN question_options TEXT;
  `,
  `
  -- The size a person picked in Add card. The chain suggestion and the small-card cost read it. Null
  -- on a card with none picked and on every card made before this column.
  ALTER TABLE cards ADD COLUMN size TEXT CHECK (size IN ('small', 'medium', 'large'));
  `,
  `
  -- Why the chain a person allowed did not start the next stage after this run ended, as the sentence
  -- Now shows. Null on every other run. On the run row, so it goes as soon as the card runs again.
  ALTER TABLE runs ADD COLUMN chain_refused TEXT;
  `,
  `
  -- The wait a run sits in after an API error, for the countdown on Now, the card and the log: why it
  -- waits, how many tries the schedule allows, and when the next try starts in Unix milliseconds.
  -- Written with each wait and cleared by the run's end. Null on every row made before these columns.
  ALTER TABLE runs ADD COLUMN retry_reason TEXT;
  ALTER TABLE runs ADD COLUMN retry_max INTEGER;
  ALTER TABLE runs ADD COLUMN retry_until INTEGER;
  `,
  `
  -- The one line a person wrote when they moved a card on after QA failed it ("Accept anyway"), for
  -- the trail and the closed card's record. Null on every other move and on every row made before
  -- this column.
  ALTER TABLE card_events ADD COLUMN reason TEXT;
  `,
  `
  -- A person's comments on lines of a card's diff. line is the line's number in the folder when the
  -- comment was made, and line_text the line as it read then, so the line is found again after an
  -- edit moves it. commit_sha is the commit the checkout was on. sent_at stays null until the comment
  -- goes back to Implement with a send back.
  CREATE TABLE diff_comments (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL CHECK (line > 0),
    line_text TEXT NOT NULL,
    body TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  ) STRICT;

  -- Every read is one card's comments, in the order they were made.
  CREATE INDEX diff_comments_card ON diff_comments (card_key, id);
  `,
  `
  -- The ask discussion an Ask run answers in, such as ask or ask-2, so a later message goes on in the
  -- same read-only session. Null on every other run and on every row made before this column.
  ALTER TABLE runs ADD COLUMN thread TEXT;
  `,
  `
  -- The built-in preset a card follows when a person picked one on its Settings tab that differs from
  -- the project's. Null follows the project's preset, which is every card made before this column.
  ALTER TABLE cards ADD COLUMN preset TEXT CHECK (preset IN ('light', 'default', 'heavy'));
  `,
  `
  -- What tells a pull request card that its author pushed since the last review round. pr_seen_sha and
  -- pr_seen_commits are the head and the commit count the last read of GitHub saw. pr_head_sha and
  -- pr_head_commits are the same two at the start of the last review round that wrote a round file,
  -- and pr_round is that round's number. Null on every card no read or round has written, which is
  -- every card made before these columns, so none of them claims a push.
  ALTER TABLE cards ADD COLUMN pr_seen_sha TEXT;
  ALTER TABLE cards ADD COLUMN pr_seen_commits INTEGER;
  ALTER TABLE cards ADD COLUMN pr_head_sha TEXT;
  ALTER TABLE cards ADD COLUMN pr_head_commits INTEGER;
  ALTER TABLE cards ADD COLUMN pr_round INTEGER CHECK (pr_round > 0);
  `,
  `
  -- The writer lock moved to machine.db (its second migration), so one Nolzu holds the machine whatever
  -- project it opens. With this table gone, the name writer on a project connection reads the attached
  -- machine's table.
  DROP TABLE writer;
  `,
  `
  -- Who set a card's title after it was made. Refine writes a short title on a local card, and the next
  -- Refine may write another. A title a person set is never replaced. Null is the title the card was
  -- made with, which is every card made before this column.
  ALTER TABLE cards ADD COLUMN title_by TEXT CHECK (title_by IN ('refine', 'person'));
  `,
  `
  -- The plan step an epic's task was made from. The person may retitle a task before adding it, and the
  -- epic still pairs the step with that task. Null on a link made by hand or before this column, which
  -- pairs by title as before.
  ALTER TABLE card_links ADD COLUMN step TEXT;
  `,
  `
  -- The Epics board's Mockups stage and phase are Design now. An epic standing on mockups would stand on
  -- no column, and its runs, moves and discussion would name a phase no stage starts, so a resume or a
  -- thread of the old phase would not find its own history. Only Epics ever had the stage, and only its
  -- stage ever ran the phase. The card folder keeps its mockups/ files, which the readers still take.
  UPDATE cards SET stage = 'design' WHERE board = 'epics' AND stage = 'mockups';
  UPDATE card_events SET from_stage = 'design' WHERE from_stage = 'mockups' AND card_key IN (SELECT key FROM cards WHERE board = 'epics');
  UPDATE card_events SET to_stage = 'design' WHERE to_stage = 'mockups' AND card_key IN (SELECT key FROM cards WHERE board = 'epics');
  UPDATE card_events SET started_phase = 'design' WHERE started_phase = 'mockups';
  UPDATE runs SET phase = 'design' WHERE phase = 'mockups';
  UPDATE messages SET thread = 'design' WHERE thread = 'mockups';
  `,
  `
  -- Whether a run's process started in the card folder, which only Codex under its own sandbox does.
  -- A resume starts where its session started, because the paths the session wrote are relative to
  -- that folder. Null on every run made before, which started where the rule of that day said.
  ALTER TABLE runs ADD COLUMN in_card_folder INTEGER CHECK (in_card_folder IN (0, 1));
  `,
  `
  -- What the git compare after a read-only run found, as JSON (ReadOnlyBreak), so the card page shows
  -- it after a reload. Null on a run that changed nothing, and on every run that is not read-only.
  ALTER TABLE runs ADD COLUMN read_only_break TEXT;
  `,
  `
  -- The wall that held the run (WallKind), so the card shows it beside the engine. Null on every run
  -- made before, which then shows nothing rather than a guess.
  ALTER TABLE runs ADD COLUMN wall TEXT CHECK (wall IN ('macos', 'bubblewrap', 'codex', 'none'));
  `,
  `
  -- The branch name a person typed on the card page. It wins over the template, so a card with no
  -- checkout yet starts on it and Refine leaves it alone. Null on a card that keeps the template's name.
  ALTER TABLE cards ADD COLUMN branch TEXT;
  `,
  `
  -- What happened while the person was away, kept after its toast is gone (notifications.ts). The id is
  -- the event's own key, such as run:12, so a second write of one event adds no row. A card key and an
  -- address are both optional: a Scout finding names no card, and a card item links to its card.
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('success', 'error', 'warning', 'info')),
    card_key TEXT,
    text TEXT NOT NULL,
    href TEXT,
    read_at TEXT
  );
  CREATE INDEX notifications_at ON notifications (at);
  `,
  `
  -- What the output check found in the files a finished run wrote, as JSON (OutputCheck). Null on a run
  -- that was not checked: one that did not end ready, an Ask, a pass, and every run made before.
  ALTER TABLE runs ADD COLUMN output_check TEXT;
  `,
  `
  -- The project's saved preset a card follows, by name, picked on its Settings tab. Null follows the
  -- built-in preset in the preset column, which is every card made before this column.
  ALTER TABLE cards ADD COLUMN saved_preset TEXT;
  `,
  `
  -- The pull requests of a Delivery card and what people wrote on them (pr-discussions.ts). Comment text
  -- stays in these tables: nothing that goes to the hub reads them. repo is owner/name in lower case,
  -- because GitHub names are case insensitive. found_by says whether the card's branch found it or a
  -- person attached it. title and state are as the last read of GitHub saw them.
  CREATE TABLE card_pulls (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    url TEXT,
    title TEXT,
    state TEXT CHECK (state IN ('open', 'closed', 'merged')),
    found_by TEXT NOT NULL CHECK (found_by IN ('branch', 'attached')),
    -- When its comments were last read, null before any read.
    read_at TEXT,
    UNIQUE (card_key, repo, number)
  ) STRICT;

  -- One row per review thread, review body or issue comment. ref is T1, T2 in the order the card first
  -- saw them, and never changes. fixed_at is when the status last became fixed, so a reviewer message
  -- after it reopens the row. needs_action is the person's override of the verdict, null when unset.
  -- fix_failed is why the last Fix of the row failed or was stopped, cleared when the next one starts.
  CREATE TABLE pr_discussions (
    id INTEGER PRIMARY KEY,
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    pull_id INTEGER NOT NULL REFERENCES card_pulls (id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('thread', 'review', 'comment')),
    github_id TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0,
    outdated INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'fixing', 'fixed', 'done')),
    verdict TEXT CHECK (verdict IN ('fix', 'reject', 'clarify', 'defer', 'none')),
    summary TEXT,
    reason TEXT,
    reply TEXT,
    fix_note TEXT,
    fixed_at TEXT,
    fix_failed TEXT,
    needs_action INTEGER,
    UNIQUE (card_key, ref),
    UNIQUE (pull_id, github_id)
  ) STRICT;

  -- The messages of a discussion. A GitHub id is unique in its discussion, so a second read adds
  -- nothing twice, and the same pull request on two cards keeps its messages on both. mine is a
  -- message by the login gh runs as, which is never unread.
  CREATE TABLE pr_messages (
    id INTEGER PRIMARY KEY,
    discussion_id INTEGER NOT NULL REFERENCES pr_discussions (id) ON DELETE CASCADE,
    github_id TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    url TEXT,
    mine INTEGER NOT NULL,
    unread INTEGER NOT NULL,
    UNIQUE (discussion_id, github_id)
  ) STRICT;
  CREATE INDEX pr_messages_discussion ON pr_messages (discussion_id, created_at);
  `,
  `
  -- The sentences an Implement run that made a commit or pushed ends with, so the card page
  -- warns after a reload. Null on a run that moved nothing, on a Fix run, which says it on its row,
  -- and on every run made before.
  ALTER TABLE runs ADD COLUMN commit_warning TEXT;
  `,
  `
  -- The project-wide stack hook moves to Start the app: its three commands become your own commands
  -- under '*', which run once per card in the card's checkout root, as the hook ran. An answer the
  -- project already has under '*' is kept. The one answer stored before answers were per repository is
  -- turned into the map first, the way the setting's reader turns it (to its repository for a start
  -- command, else to '*'). The hook rows go either way. Each command is trimmed of spaces, tabs and line
  -- ends, as the setting's reader trims it, so a blank hook makes no answer the reader would refuse.
  INSERT INTO settings (key, value)
  SELECT 'qaApp', json_insert(
    coalesce(
      (SELECT CASE
        WHEN json_type(value) IS NOT 'object' THEN '{}'
        WHEN json_type(value, '$.mode') IS NULL THEN value
        WHEN json_extract(value, '$.mode') = 'dev' THEN json_object(json_extract(value, '$.repo'), json(value))
        ELSE json_object('*', json(value))
      END FROM settings WHERE key = 'qaApp' AND json_valid(value)),
      '{}'
    ),
    '$."*"',
    json_object(
      'mode', 'own',
      'start', trim(json_extract(hook.value, '$'), char(32, 9, 10, 13)),
      'stop', (SELECT nullif(trim(json_extract(value, '$'), char(32, 9, 10, 13)), '') FROM settings WHERE key = 'stackUnloadHook' AND json_valid(value) AND json_type(value) = 'text'),
      'status', (SELECT nullif(trim(json_extract(value, '$'), char(32, 9, 10, 13)), '') FROM settings WHERE key = 'stackStatusHook' AND json_valid(value) AND json_type(value) = 'text')
    )
  )
  FROM settings AS hook
  WHERE hook.key = 'stackHook' AND json_valid(hook.value) AND json_type(hook.value) = 'text' AND trim(json_extract(hook.value, '$'), char(32, 9, 10, 13)) <> ''
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
  DELETE FROM settings WHERE key IN ('stackHook', 'stackUnloadHook', 'stackStatusHook');
  `,
  `
  -- The subject of an Ask discussion, which its list row shows. A small pass writes it after the first
  -- answer, and a person can rename it. by_person marks a name a person gave, which the pass never
  -- writes over.
  CREATE TABLE thread_subjects (
    card_key TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    thread TEXT NOT NULL,
    subject TEXT NOT NULL,
    by_person INTEGER NOT NULL DEFAULT 0 CHECK (by_person IN (0, 1)),
    PRIMARY KEY (card_key, thread)
  ) STRICT;
  `,
  `
  -- Research is one board now, and its two kinds share their column ids: Research where a question had
  -- researching and an investigation had running, and Review where they had answer and report. A card
  -- on an old id would stand on no column. The phases keep their names, so runs and threads stay.
  UPDATE cards SET stage = 'research' WHERE (board = 'questions' AND stage = 'researching') OR (board = 'investigations' AND stage = 'running');
  UPDATE cards SET stage = 'review' WHERE (board = 'questions' AND stage = 'answer') OR (board = 'investigations' AND stage = 'report');
  UPDATE card_events SET from_stage = 'research' WHERE from_stage = 'researching' AND card_key IN (SELECT key FROM cards WHERE board = 'questions');
  UPDATE card_events SET from_stage = 'research' WHERE from_stage = 'running' AND card_key IN (SELECT key FROM cards WHERE board = 'investigations');
  UPDATE card_events SET from_stage = 'review' WHERE from_stage = 'answer' AND card_key IN (SELECT key FROM cards WHERE board = 'questions');
  UPDATE card_events SET from_stage = 'review' WHERE from_stage = 'report' AND card_key IN (SELECT key FROM cards WHERE board = 'investigations');
  UPDATE card_events SET to_stage = 'research' WHERE to_stage = 'researching' AND card_key IN (SELECT key FROM cards WHERE board = 'questions');
  UPDATE card_events SET to_stage = 'research' WHERE to_stage = 'running' AND card_key IN (SELECT key FROM cards WHERE board = 'investigations');
  UPDATE card_events SET to_stage = 'review' WHERE to_stage = 'answer' AND card_key IN (SELECT key FROM cards WHERE board = 'questions');
  UPDATE card_events SET to_stage = 'review' WHERE to_stage = 'report' AND card_key IN (SELECT key FROM cards WHERE board = 'investigations');
  `,
  `
  -- PR reviews has no Re-review column now: Agent pre-review runs every round. A card on the old column
  -- would stand on no column, so it goes to Agent pre-review, and so do its moves, so the trail names a
  -- column the board still draws. The runs keep the pr-review phase, and the rounds stay in the folder.
  UPDATE cards SET stage = 'pre-review' WHERE board = 'prreview' AND stage = 're-review';
  UPDATE card_events SET from_stage = 'pre-review' WHERE from_stage = 're-review' AND card_key IN (SELECT key FROM cards WHERE board = 'prreview');
  UPDATE card_events SET to_stage = 'pre-review' WHERE to_stage = 're-review' AND card_key IN (SELECT key FROM cards WHERE board = 'prreview');
  `,
  `
  -- The tickets a person deleted from the board, by the reference the card kept (repo#n of a pull request,
  -- owner/repo#n of an issue, PROJ-123 of Jira). The read of pull requests skips one listed here, so a
  -- deleted card does not come back on the next read. Adding the ticket again by hand takes it off.
  CREATE TABLE deleted_tickets (
    source_ref TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    card_key TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  `,
];

// The machine database, one per data folder whatever the number of projects. Its own list with its own
// version, under the same rule: never change a released entry, append a new one.
export const machineMigrations: readonly string[] = [
  `
  -- The settings that follow the machine and not one project (MACHINE_KEYS), in the shape of a project's
  -- settings table.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  -- The projects this machine runs, by the file of each one's database relative to the data folder.
  -- The name is one no project database uses, so the same query reads it on a machine connection and on
  -- a project connection with the machine database attached.
  CREATE TABLE project_registry (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL UNIQUE
  ) STRICT;
  `,
  `
  -- One writer per machine. Two schedulers on one data folder would both claim the same cards and start
  -- the same run twice, whatever project each opened. One row only, which the check pins.
  CREATE TABLE writer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
  `,
];
