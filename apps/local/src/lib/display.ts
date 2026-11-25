import { readDisplay, type DisplayEntitlement, type SignedDisplay } from '@nolzu/protocol';

/**
 * The public keys this build trusts, newest first.
 *
 * A list rather than one key, because rotating the server's key would otherwise turn every
 * client already installed into a permanent Free client. A new key goes on the front, the old
 * one stays until the builds that only know it are gone.
 */
export const DISPLAY_PUBLIC_KEYS = ['kJFVeRRrwNvHcpjbxXZAEiJX_PjUPohQTjDzFVZxjBw'] as const;

// Free, and the only thing this app ever shows without a signed document saying otherwise.
export const FREE: DisplayEntitlement = {
	id: '',
	plan: 'free',
	features: [],
	seats: 0,
	expiresAt: 0,
};

/**
 * What the menus may show.
 *
 * Anything that does not verify is Free: a forged document, an expired one, one about somebody
 * else, or a runtime that cannot check the signature at all. Free is the whole local product
 * and is never an error, so there is nothing to report and nobody to report it to.
 *
 * This decides what is drawn and nothing else. Every paid capability is checked again on the
 * server when it is used, so a document that lied would only ever draw a menu that then
 * answers 402.
 */
export async function displayFrom(
	signed: SignedDisplay | null,
	expectedId: string | undefined,
	keys: readonly string[] = DISPLAY_PUBLIC_KEYS,
	now?: number,
): Promise<DisplayEntitlement> {
	if (!signed) return FREE;
	for (const key of keys) {
		const read = await readDisplay(signed, key, { expectedId, now });
		if (read) return read;
	}
	return FREE;
}

// Half the life left. A client that waited for the expiry would drop to Free mid-work and only
// then ask, so the menus would flicker away for as long as the fetch takes.
export function refreshAfterSeconds(
	document: DisplayEntitlement,
	now: number = Math.floor(Date.now() / 1000),
): number {
	const left = document.expiresAt - now;
	if (left <= 0) return 0;
	return Math.floor(left / 2);
}

/**
 * The feature that opens a day other than today on the evidence screen.
 *
 * Its own name and not `cloud-board`, because evidence history is a feature of its own. The hub keeps the
 * same name for the stored blocks, so one word covers the screen and the rows behind it.
 */
export const HISTORY_FEATURE = 'evidence-history';

/**
 * The feature that sends a week of the timesheet to a time tracker.
 *
 * The feature name the account's plan carries, and not the plan word beside it. It decides whether
 * the evidence screen draws the Export button and the connections, and the two actions behind them
 * ask for it again on every post.
 */
export const EXPORT_FEATURE = 'exporters';

export const shows = (document: DisplayEntitlement, feature: string): boolean =>
	document.features.includes(feature);

/**
 * The feature that says the hub files each frame under the project it names.
 *
 * A hub without it keeps one project per machine, the one whose `project.sync` came last, and runs a
 * job with no project on the first project. The hub link sends that hub the first project alone, so
 * a board row and a job cannot land on another project. The hub signs it once it reads `project`.
 */
export const HUB_PROJECTS_FEATURE = 'hub-projects';

/**
 * The project a route works on, by its id in the machine's project registry.
 *
 * It is the current project, the one the person opened last, unless the route names another. Every
 * plan holds as many projects as the person makes: the paid plans add cloud
 * features. A current id the registry lost reads as the first project.
 */
export function activeProject(registered: readonly number[], current: number | null, asked?: number): number {
	const open = current !== null && registered.includes(current) ? current : registered[0];
	if (open === undefined) throw new Error('This machine has no project yet. Make one on New project.');
	if (asked === undefined || asked === open) return open;
	if (!registered.includes(asked)) throw new Error(`There is no project ${asked} on this machine.`);
	return asked;
}

/**
 * The feature that links Team from Settings, Cloud connection and opens `/team`.
 *
 * `claims` because every member of a team meets it on the shared board, and Solo never carries it.
 * The other three Team names travel with it on every Team document, so one word is enough.
 */
export const TEAM_FEATURE = 'claims';

// Where the web app keeps the team's members, roles, invites and seats, or null for an account with
// no team. The team's screens read the team's shared data, which lives on the cloud, so this page
// links there rather than drawing a copy.
export const webTeamHref = (document: DisplayEntitlement, base: string): string | null =>
	shows(document, TEAM_FEATURE) ? `${base.replace(/\/$/, '')}/team` : null;

/**
 * Where the account on the cloud is, or null on Free.
 *
 * The one thing the layout draws from the document today, so the rule is here and the layout
 * carries no second copy of it. `cloud-board` is the Solo feature the client links out for.
 */
export const accountHref = (document: DisplayEntitlement, base: string): string | null =>
	shows(document, 'cloud-board') ? `${base.replace(/\/$/, '')}/account` : null;
