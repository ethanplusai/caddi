// The Vault's own view rules: which agents could use a login right now and why, and how the owner's list is
// grouped and searched. Pure functions over what the app already knows; the same rules the access layer
// enforces (access.mjs guardLoginFill, logins.mjs forAgent/agentLogin), stated for the owner.
// Plain reasons. Each says what stopped the use, never anything about the password.
export const VAULT_REASONS = Object.freeze({
  'switch-off': 'The login’s “Agents may use this login” switch is off.',
  'not-approved': 'You did not allow this agent to use saved logins, or it has view-only access.',
  'waiting-for-you': 'Waiting for you to confirm the agent’s first use.',
  'first-use-declined': 'You said no to this agent using the login.',
  'origin-mismatch': 'The page was not on the login’s exact site, or the site is outside the agent’s access.',
  paused: 'Agents were paused in this workspace.',
  'sensitive-context': 'The page showed a saved password, so Caddi stopped.',
  'no-control': 'The agent did not hold control of the page, or you took over.',
  'no-password-field': 'The page had no visible password field.',
  'ambiguous-form': 'The page had more than one password field, so Caddi did not guess.',
  'page-changed': 'The page changed before the login could be filled.',
  'keychain-locked': 'The login keychain was locked.',
  'keychain-unavailable': 'The keychain did not answer.',
  'password-missing': 'The keychain no longer has this password.',
  'presence-not-confirmed': 'macOS did not confirm it was you.',
  'too-many-requests': 'Too many requests to you at once, so this one was refused.',
  'outcome-unknown': 'Caddi could not tell whether the fill happened.',
  cancelled: 'The request was cancelled or ran out of time.',
  failed: 'The fill could not be completed.',
});
const plainName = value => String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/gu, ' ').trim().slice(0, 48) || 'An agent';

/**
 * For one login in one workspace: every agent connected to that workspace, and whether it could fill this login
 * now. `can` is 'yes' (fills without asking), 'asks' (you will be asked first), or 'no'. `why` is one plain sentence.
 * The order of checks follows the enforcement order, so the first reason given is the one that would stop it.
 */
export function agentAccessForLogin(login, { workspace, connections = [], paused = false, signInStatus = () => null } = {}) {
  if (!login || !workspace) return { summary: 'No agent can use this login.', agents: [] };
  if (workspace.kind === 'personal') return { summary: 'Agents never work in your personal workspace, so none can use this login here.', agents: [] };
  const here = connections.filter(item => item && item.workspaceId === workspace.id && ['approved', 'connected'].includes(item.status) && item.workspaceActive === true);
  const agents = here.map(item => {
    const name = plainName(item.clientName), base = { agentSessionId: item.agentSessionId, name, startedBy: 'owner' };
    const no = why => ({ ...base, can: 'no', why });
    if (item.logins !== true) return no('You did not allow it to use saved logins when you approved it.');
    if (item.mode !== 'control') return no('It has view-only access. It can see this login’s name, but filling needs control.');
    if (!login.agentUse) return no('“Agents may use this login” is off.');
    if (!Array.isArray(item.origins) || !item.origins.includes(login.origin)) return no('This site is not one of the sites you gave it.');
    if (login.state === 'needs-password') return no('The keychain no longer has this password.');
    if (paused) return no('Agents are paused in this workspace.');
    const decision = signInStatus(item.agentSessionId, login.loginId);
    if (decision === 'denied') return no('You said no to it using this login in this session.');
    if (decision === 'allowed-session') return { ...base, can: 'yes', why: 'You allowed it for this session.' };
    if (decision === 'pending') return { ...base, can: 'asks', why: 'It is waiting for you to confirm now.' };
    return { ...base, can: 'asks', why: 'It may ask. You confirm its first use.' };
  });
  const able = agents.filter(item => item.can !== 'no').length;
  const summary = !login.agentUse ? 'Agents can’t use this login: its switch is off.' :
    !here.length ? 'No agent is connected to this workspace right now.' :
    able ? (able === 1 ? '1 agent' : able + ' agents') + ' could use this login now.' : 'No connected agent can use this login now.';
  return { summary, agents };
}

/** Site host for grouping and display. */
export const loginHost = origin => { try { return new URL(origin).host; } catch { return String(origin ?? ''); } };

/** Case-insensitive search over site, username and label. */
export function searchLogins(logins, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...logins];
  return logins.filter(item => [loginHost(item.origin), item.origin, item.username, item.label].some(value => String(value ?? '').toLowerCase().includes(needle)));
}

/** Logins grouped by site, sites in alphabetical order, logins by label then username. */
export function groupLoginsBySite(logins) {
  const groups = new Map();
  for (const item of logins) {
    const key = item.origin;
    if (!groups.has(key)) groups.set(key, { origin: key, host: loginHost(key), logins: [] });
    groups.get(key).logins.push(item);
  }
  const text = value => String(value ?? '').toLowerCase();
  return [...groups.values()].sort((a, b) => a.host.localeCompare(b.host))
    .map(group => ({ ...group, logins: group.logins.sort((a, b) => text(a.label).localeCompare(text(b.label)) || text(a.username).localeCompare(text(b.username))) }));
}

/** "you" or the agent's approved name, for an activity entry. */
export const activityWho = actor => actor?.kind === 'agent' ? plainName(actor.name) : 'You';

/** "just now", "4 min ago", "2 hr ago", "yesterday", "3 days ago". */
export function relativeTime(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}
/** One plain sentence for an activity entry: "Builder filled ada@example.test on login.test" or why it did not. */
export function activitySentence(item) {
  const who = activityWho(item?.actor), what = { fill: 'fill', copy: 'copy the password of', reveal: 'show the password of' }[item?.action] ?? 'use';
  const login = item?.username || item?.label || 'a login', site = loginHost(item?.origin);
  const times = item?.count > 1 ? ' (' + item.count + ' times)' : '';
  if (item?.outcome === 'filled') return who + ' filled ' + login + ' on ' + site + times;
  if (item?.outcome === 'copied') return who + ' copied the password of ' + login + times;
  if (item?.outcome === 'shown') return who + ' showed the password of ' + login + times;
  const reason = VAULT_REASONS[item?.reason] ?? VAULT_REASONS.failed;
  const verb = item?.outcome === 'waiting' ? ' asked to ' : ' tried to ';
  return who + verb + what + ' ' + login + ' on ' + site + times + '. ' + reason;
}
