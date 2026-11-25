import { remoteOwner } from './create-card.ts';
import { database } from './db.ts';
import { loop } from './loop.ts';
import { type ScoutFindingDetail, scoutFindingDetail } from './scout-detail.ts';
import { markScoutSeen, scoutFindingsFor } from './scout-findings.ts';
import { scoutFor } from './scout-sources.ts';

/**
 * What both Scout addresses draw: the findings, the sources they come from, and the finding on show.
 * `/scout` shows the one seen last, and `/scout/f/<id>` its own, which that route reads first.
 *
 * Rows only: a source's token is in the OS keychain, and reading it here would ask the person for
 * their keychain password every time they open this screen.
 *
 * Opening Scout moves the seen marker, and the loop's change report carries that to the rail's dot on
 * every open page. Only when it moved, so a visit with nothing new wakes no stream.
 *
 * The first visit names the owner of the project's GitHub remote on the GitHub card. That is one git
 * call, so it goes as a promise the page does not wait for, and only while there is no source.
 */
export function scoutPage(finding?: ScoutFindingDetail) {
  const db = database();
  if (markScoutSeen(db)) loop().changed();
  const findings = scoutFindingsFor(db);
  const first = findings.rows[0];
  const read = (id: number) => {
    const found = scoutFindingDetail(db, String(id));
    return found.ok ? found.detail : null;
  };
  const scout = scoutFor(db);
  const githubOwner = scout.rows.length === 0 ? remoteOwner(db) : Promise.resolve(null);
  return { findings, scout, githubOwner, finding: finding ?? (first === undefined ? null : read(first.id)) };
}
