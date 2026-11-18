// The Vault: the access log store, CSV import (each format, hostile files, the review), the save-offer rules
// and "never for this site" list, the keyed Save/Update comparison, and which agents could use a login and why.
// Everything runs against the in-memory keychain stand-in and made-up data (example.com, .test). No real keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createVaultActivity, activityOutcome, VAULT_ACTIVITY_LIMITS, VAULT_REASONS } from '../src/caddi/desktop/vault-activity.mjs';
import { parseCsv, detectImportFormat, importCandidates, reviewImport, prepareImport, readImportFile, decodeImport, importOrigin,
  wipeCandidates, IMPORT_FORMATS, IMPORT_LIMITS, IMPORT_SKIP_REASONS } from '../src/caddi/desktop/vault-import.mjs';
import { offerDecision, samePassword, validOfferReport, createOfferHolder, createNeverSaveList, OFFER_LIMITS } from '../src/caddi/desktop/vault-offer.mjs';
import { agentAccessForLogin, searchLogins, groupLoginsBySite, activityWho } from '../src/caddi/desktop/vault.mjs';
import { createLoginStore } from '../src/caddi/desktop/logins.mjs';
import { createFakeLoginSecrets } from '../src/caddi/platform/login-secrets.mjs';

const code = expected => error => error.code === expected;
const fixture = name => fs.readFileSync(new URL('./fixtures/vault/' + name, import.meta.url), 'utf8');
async function folder(t, prefix) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, prefix))); await fsp.chmod(directory, 0o700);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}
const owner = { kind: 'owner' };
const agent = (name = 'Builder', id = 'session-1') => ({ kind: 'agent', agentSessionId: id, name, startedBy: 'owner' });
const entry = (over = {}) => ({ workspaceId: 'a', loginId: 'login-1', origin: 'https://login.test', label: 'Staging', username: 'ada@example.test',
  actor: owner, action: 'fill', outcome: 'filled', reason: null, ...over });

// ── Access log ──

test('the access log records who used which login, never a password, 0600 per workspace, newest first', async t => {
  const directory = path.join(await folder(t, 'va-'), 'activity');
  let clock = 1_000_000;
  const log = createVaultActivity({ directory, now: () => clock });
  assert.deepEqual(log.record(entry()), { recorded: true, merged: false });
  clock += 10;
  log.record(entry({ actor: agent(), outcome: 'denied', reason: 'switch-off' }));
  clock += 10;
  log.record(entry({ workspaceId: 'b', loginId: 'login-2' }));
  const file = path.join(directory, 'a.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const listed = log.list('a');
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.entries.map(item => [item.actor.kind, item.outcome, item.reason]), [['agent', 'denied', 'switch-off'], ['owner', 'filled', null]]);
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ['action', 'actor', 'at', 'count', 'id', 'label', 'loginId', 'origin', 'outcome', 'reason', 'username']);
  assert.equal(log.list('b').total, 1, 'per workspace');
  assert.equal(log.list('a', { loginId: 'login-2' }).total, 0, 'filtered by login');
  // A fresh store reads the same file back.
  assert.equal(createVaultActivity({ directory }).list('a').total, 2);
  // A password-shaped field is refused outright: the entry has exact keys.
  assert.equal(log.record({ ...entry(), password: 'test-password-123' }).recorded, false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('test-password-123'));
});

test('repeats within a minute are counted on one entry; the log is capped, oldest dropped', async t => {
  const directory = path.join(await folder(t, 'vb-'), 'activity');
  let clock = 5_000_000;
  const log = createVaultActivity({ directory, now: () => clock });
  for (let i = 0; i < 5; i++) { log.record(entry({ actor: agent(), outcome: 'waiting', reason: 'waiting-for-you' })); clock += 15_000; }
  let listed = log.list('a');
  assert.equal(listed.total, 1, 'an agent polling for the owner\'s answer is one entry');
  assert.equal(listed.entries[0].count, 5);
  clock += 120_000;
  log.record(entry({ actor: agent(), outcome: 'waiting', reason: 'waiting-for-you' }));
  assert.equal(log.list('a').total, 2, 'after a quiet minute it is a new entry');
  for (let i = 0; i < VAULT_ACTIVITY_LIMITS.entries + 20; i++) { clock += 1; log.record(entry({ loginId: 'login-' + (i % 2 ? 'x' : 'y') })); }
  listed = log.list('a', { limit: VAULT_ACTIVITY_LIMITS.listMax });
  assert.equal(listed.total, VAULT_ACTIVITY_LIMITS.entries, 'capped');
  assert.ok(listed.entries.every(item => item.outcome === 'filled'), 'the oldest entries went first');
});

test('the log is validated on read; a damaged file is left alone until the owner clears it', async t => {
  const directory = path.join(await folder(t, 'vc-'), 'activity');
  const log = createVaultActivity({ directory });
  log.record(entry());
  const file = path.join(directory, 'a.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.entries[0].reason = 'made-up';
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const reopened = createVaultActivity({ directory });
  assert.equal(reopened.list('a').damaged, true);
  assert.equal(reopened.record(entry()).recorded, false, 'nothing is written over a damaged log');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].reason, 'made-up', 'left as it was');
  reopened.clear('a');
  assert.ok(!fs.existsSync(file));
  assert.equal(reopened.record(entry()).recorded, true);
  // A file other users can read is not trusted.
  fs.chmodSync(file, 0o644);
  assert.equal(createVaultActivity({ directory }).list('a').damaged, true);
  fs.chmodSync(file, 0o600);
  // Workspaces that no longer exist lose their log, as their other data goes.
  createVaultActivity({ directory }).record(entry({ workspaceId: 'gone' }));
  assert.deepEqual(createVaultActivity({ directory }).retain(['a']), { removed: 1 });
  assert.ok(fs.existsSync(file) && !fs.existsSync(path.join(directory, 'gone.json')));
  assert.throws(() => log.list('../x'), code('INVALID_ARGUMENT'));
});

test('error codes map to plain reasons; every reason has owner-facing text', () => {
  assert.deepEqual(activityOutcome('fill', null), { outcome: 'filled', reason: null });
  assert.deepEqual(activityOutcome('copy', null), { outcome: 'copied', reason: null });
  assert.deepEqual(activityOutcome('fill', 'LOGIN_NOT_AVAILABLE'), { outcome: 'denied', reason: 'switch-off' });
  assert.deepEqual(activityOutcome('fill', 'ACCESS_DENIED'), { outcome: 'denied', reason: 'not-approved' });
  assert.deepEqual(activityOutcome('fill', 'LOGIN_NOT_ALLOWED'), { outcome: 'denied', reason: 'first-use-declined' });
  assert.deepEqual(activityOutcome('fill', 'LOGIN_SITE_MISMATCH'), { outcome: 'denied', reason: 'origin-mismatch' });
  assert.deepEqual(activityOutcome('fill', 'PRIVACY_BLOCKED'), { outcome: 'denied', reason: 'paused' });
  assert.deepEqual(activityOutcome('fill', 'LOGIN_SECRET_EXPOSED'), { outcome: 'denied', reason: 'sensitive-context' });
  assert.deepEqual(activityOutcome('fill', 'LOGIN_CONFIRMATION_PENDING'), { outcome: 'waiting', reason: 'waiting-for-you' });
  assert.deepEqual(activityOutcome('fill', 'KEYCHAIN_LOCKED'), { outcome: 'failed', reason: 'keychain-locked' });
  assert.deepEqual(activityOutcome('fill', 'SOMETHING_NEW'), { outcome: 'failed', reason: 'failed' });
  for (const [key, text] of Object.entries(VAULT_REASONS)) assert.ok(text.length > 10 && !/password:/i.test(text), key);
});

// ── Import ──

const expected = {
  'bitwarden.csv': ['bitwarden', [['ready', 'app.example.com', 'ada@example.test'], ['skip', '', '', 'not-a-login'], ['ready', 'other.example.test', 'bo@example.test']]],
  'lastpass.csv': ['lastpass', [['ready', 'app.example.com', 'ada@example.test'], ['skip', 'http://insecure.example.test', 'cy@example.test', 'no-https-origin'], ['skip', 'http://sn', '', 'no-https-origin']]],
  'dashlane.csv': ['dashlane', [['ready', 'app.example.com', 'ada@example.test'], ['skip', 'android://com.example.app', 'bo@example.test', 'no-https-origin']]],
  '1password.csv': ['1password', [['ready', 'app.example.com', 'ada@example.test'], ['skip', '', 'di@example.test', 'missing-site']]],
  'apple.csv': ['apple', [['ready', 'app.example.com', 'ada@example.test'], ['skip', 'app.example.com', 'ada@example.test', 'duplicate-in-file']]],
  'chrome.csv': ['chrome', [['ready', 'app.example.com', 'ada@example.test'], ['ready', 'localhost:3000', 'dev'], ['skip', 'empty.example.test', 'ed@example.test', 'missing-password']]],
  'generic.csv': ['generic', [['ready', 'app.example.com', 'ada@example.test']]],
};
test('each export format is recognised from its header and reviewed row by row', () => {
  for (const [name, [format, rows]] of Object.entries(expected)) {
    const prepared = prepareImport(fixture(name));
    assert.equal(prepared.format.id, format, name);
    const review = reviewImport(prepared.candidates);
    assert.deepEqual(review.rows.map(row => row.status === 'ready' ? [row.status, row.site, row.username] : [row.status, row.site, row.username, row.reason]), rows, name);
    assert.ok(!JSON.stringify(review).match(/-pass-/), 'the review never carries a password: ' + name);
    const ready = prepared.candidates.filter(item => item.password);
    assert.ok(ready.every(item => Buffer.isBuffer(item.password)));
    wipeCandidates(prepared.candidates);
    assert.ok(ready.every(item => item.password.every(byte => byte === 0)), 'wiped');
  }
  const bitwarden = prepareImport(fixture('bitwarden.csv'));
  assert.equal(bitwarden.candidates[2].password.toString(), 'bw "quoted" pass', 'escaped quotes');
  assert.equal(new Set(IMPORT_FORMATS.map(item => item.id)).size, IMPORT_FORMATS.length);
  for (const item of IMPORT_FORMATS) assert.ok(['documented', 'unverified'].includes(item.verified));
  for (const reason of new Set(Object.values(expected).flatMap(([, rows]) => rows.map(row => row[3]).filter(Boolean)))) assert.ok(IMPORT_SKIP_REASONS[reason], reason);
});

test('format detection: header order and case do not matter; unknown headers are refused', () => {
  assert.equal(detectImportFormat(['PASSWORD', 'Url', 'username', 'Name']).id, 'chrome');
  assert.equal(detectImportFormat(['Title', 'URL', 'Username', 'Password', 'Notes', 'OTPAuth']).id, 'apple');
  assert.equal(detectImportFormat(['Title', 'Url', 'Username', 'Password', 'OTPAuth', 'Favorite', 'Archived', 'Tags', 'Notes']).id, '1password');
  assert.equal(detectImportFormat(['url', 'username', 'password', 'extra', 'name', 'grouping', 'fav']).id, 'lastpass', 'LastPass without totp');
  assert.equal(detectImportFormat(['date', 'amount', 'payee']), null);
  assert.equal(detectImportFormat(['url', 'url', 'password']), null, 'duplicate columns are ambiguous');
  assert.equal(detectImportFormat(['username', 'password']), null, 'no site column');
  assert.throws(() => prepareImport('date,amount\n1,2\n'), code('IMPORT_FORMAT_UNKNOWN'));
  assert.throws(() => prepareImport('url,username,password\n'), code('IMPORT_EMPTY'));
});

test('the CSV parser is strict: quotes, embedded commas and line breaks, BOM; hostile files are refused', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","line\none"\n'), { header: ['a', 'b'], rows: [['x, y', 'line\none']] });
  assert.deepEqual(parseCsv('a,b\n"",""\n\n').rows, [['', '']], 'empty quoted fields kept, blank lines skipped');
  assert.deepEqual(parseCsv('a,b\nx,').rows, [['x', '']], 'no trailing newline');
  for (const [text, expectedCode] of [['a,b\nx"y,z\n', 'IMPORT_FILE_INVALID'], ['a,b\n"x"y,z\n', 'IMPORT_FILE_INVALID'], ['a,b\n"x,z\n', 'IMPORT_FILE_INVALID'],
    ['a,b\nx\0,y\n', 'IMPORT_FILE_INVALID'], ['', 'IMPORT_EMPTY'], ['\n\n', 'IMPORT_EMPTY'],
    ['a,b\n' + 'x,'.repeat(70) + 'x\n', 'IMPORT_TOO_MANY_COLUMNS'], ['a\n"' + 'x'.repeat(IMPORT_LIMITS.fieldChars + 1) + '"\n', 'IMPORT_FIELD_TOO_LONG']])
    assert.throws(() => parseCsv(text), code(expectedCode), JSON.stringify(text.slice(0, 30)));
  assert.throws(() => parseCsv('url,username,password\n' + 'https://a.test,u,p\n'.repeat(IMPORT_LIMITS.rows + 1)), code('IMPORT_TOO_MANY_ROWS'));
  // Rows with the wrong number of columns are skipped, never shifted into other columns.
  const prepared = prepareImport('name,url,username,password\nx,https://a.test,u,p,extra\nshort,https://b.test\n');
  assert.deepEqual(prepared.candidates.map(item => item.skip), ['malformed-row', 'malformed-row']);
  // Formula-looking cells are only text: nothing is evaluated, and the site must still be an https origin.
  const formula = prepareImport('name,url,username,password\n"=HYPERLINK(""x"")",=cmd|calc,@user,+pass\n');
  assert.equal(formula.candidates[0].skip, 'no-https-origin');
  // Control characters in a username are refused; bidi overrides too.
  assert.equal(prepareImport('name,url,username,password\nx,https://a.test,"a‮b",p\n').candidates[0].skip, 'invalid-text');
  assert.equal(prepareImport('name,url,username,password\nx,https://a.test,u,' + 'p'.repeat(1025) + '\n').candidates[0].skip, 'too-long');
  assert.throws(() => decodeImport(Buffer.from([0x61, 0xff, 0xfe])), code('IMPORT_FILE_INVALID'), 'not UTF-8');
  assert.throws(() => decodeImport(Buffer.alloc(IMPORT_LIMITS.bytes + 1)), code('IMPORT_FILE_TOO_LARGE'));
});

test('import origins: https, or http on this Mac only; never credentials in the address; bare hosts are https', () => {
  assert.equal(importOrigin('https://app.example.com/login?x=1'), 'https://app.example.com');
  assert.equal(importOrigin('app.example.com'), 'https://app.example.com');
  assert.equal(importOrigin('http://localhost:8080/'), 'http://localhost:8080');
  for (const value of ['http://app.example.com', 'ftp://x.test', 'android://com.example', 'https://user:pw@x.test', 'javascript:alert(1)', 'https://a b.test', '', 'x'.repeat(3000)])
    assert.equal(importOrigin(value), null, value);
});

test('the review is per workspace: already saved, duplicates, and the store\'s limit', () => {
  const { candidates } = prepareImport('name,url,username,password\na,https://a.test,u,p1\nb,https://b.test,u,p2\nc,https://c.test,u,p3\nd,https://a.test,u,p4\n');
  const review = reviewImport(candidates, { existing: [{ origin: 'https://b.test', username: 'u' }], capacity: 1 });
  assert.deepEqual(review.rows.map(row => row.reason ?? 'ready'), ['ready', 'already-saved', 'over-limit', 'duplicate-in-file']);
  assert.equal(review.ready, 1); assert.equal(review.skipped, 3);
});

test('the import file is read once: a regular file under the size limit, not a link', async t => {
  const directory = await folder(t, 'vi-');
  const file = path.join(directory, 'export.csv'); fs.writeFileSync(file, fixture('chrome.csv'));
  assert.equal(prepareImport(readImportFile(file)).format.id, 'chrome');
  const link = path.join(directory, 'link.csv'); fs.symlinkSync(file, link);
  assert.throws(() => readImportFile(link), code('IMPORT_FILE_UNAVAILABLE'));
  assert.throws(() => readImportFile(directory), code('IMPORT_FILE_UNAVAILABLE'));
  assert.throws(() => readImportFile('relative.csv'), code('IMPORT_FILE_UNAVAILABLE'));
  const big = path.join(directory, 'big.csv'); fs.writeFileSync(big, Buffer.alloc(IMPORT_LIMITS.bytes + 1, 0x61));
  assert.throws(() => readImportFile(big), code('IMPORT_FILE_TOO_LARGE'));
});

test('imported logins are stored through the secret store with the agent switch off', async t => {
  const directory = await folder(t, 'vs-');
  const secrets = createFakeLoginSecrets();
  const store = createLoginStore({ directory: path.join(directory, 'logins'), secrets, workspaceFor: id => id === 'a' ? { id } : null });
  const { candidates } = prepareImport(fixture('chrome.csv'));
  const review = reviewImport(candidates);
  for (const row of review.rows.filter(item => item.status === 'ready')) {
    const item = candidates.find(value => value.rowId === row.rowId);
    store.add({ workspaceId: 'a', origin: item.origin, username: item.username, label: item.title || undefined, password: item.password.toString('utf8') });
  }
  wipeCandidates(candidates);
  assert.equal(secrets.testing.count(), 2);
  assert.ok(store.view('a').logins.every(item => item.agentUse === false), 'imported logins start with agents off');
  assert.ok(!fs.readFileSync(path.join(directory, 'logins', 'logins.json'), 'utf8').includes('ch-pass'));
});

// ── Offer to save ──

const facts = (over = {}) => ({ privateWindow: false, workspace: { id: 'a', kind: 'project' }, storeAvailable: true, leaseActive: false,
  agentRequestActive: false, lastAgentActivityAt: 0, humanActivationAt: 99_000, now: 100_000, pageOrigin: 'https://login.test',
  origin: 'https://login.test', username: 'ada@example.test', neverSites: [], matches: [], capacityLeft: 10, samePassword: null, ...over });
test('an offer only after the owner\'s own sign-in, never in a private window or while an agent acts', () => {
  assert.deepEqual(offerDecision(facts()), { offer: 'save', reason: null, loginId: null });
  assert.equal(offerDecision(facts({ workspace: { id: 'p', kind: 'personal' } })).offer, 'save', 'personal workspaces too');
  const refusals = {
    'private-window': { privateWindow: true }, workspace: { workspace: { id: 'a', kind: 'project', lifecycle: { status: 'archived' } } },
    'vault-unavailable': { storeAvailable: false },
    'agent-control': { leaseActive: true }, 'agent-recent': { lastAgentActivityAt: 97_000 },
    'no-human-input': { humanActivationAt: 90_000 }, origin: { origin: 'https://evil.test' }, never: { neverSites: ['https://login.test'] },
    capacity: { capacityLeft: 0 },
  };
  for (const [reason, change] of Object.entries(refusals)) assert.deepEqual(offerDecision(facts(change)), { offer: null, reason, loginId: null }, reason);
  assert.equal(offerDecision(facts({ agentRequestActive: true })).reason, 'agent-control', 'an agent request on the page');
  assert.equal(offerDecision(facts({ humanActivationAt: 0 })).reason, 'no-human-input', 'no owner input at all');
  assert.equal(offerDecision(facts({ humanActivationAt: 101_000 })).reason, 'no-human-input', 'input from the future is not trusted');
  assert.equal(offerDecision(facts({ privateWindow: undefined })).reason, 'private-window', 'unknown is treated as private');
  assert.equal(offerDecision(facts({ leaseActive: undefined })).reason, 'agent-control', 'unknown lease is treated as held');
  assert.equal(offerDecision(facts({ lastAgentActivityAt: undefined })).reason, 'agent-recent');
  assert.equal(offerDecision(null).reason, 'private-window');
  const matches = [{ loginId: 'login-1', username: 'ada@example.test' }];
  assert.deepEqual(offerDecision(facts({ matches, samePassword: false })), { offer: 'update', reason: null, loginId: 'login-1' });
  assert.equal(offerDecision(facts({ matches, samePassword: true })).reason, 'already-saved');
  assert.equal(offerDecision(facts({ matches, samePassword: null })).reason, 'already-saved', 'unknown comparison: no update offer');
  assert.equal(offerDecision(facts({ matches, username: 'bo@example.test' })).offer, 'save', 'another username on the same site');
  assert.ok(OFFER_LIMITS.agentQuietMs > OFFER_LIMITS.humanWindowMs, 'an agent action just before the owner\'s click still blocks the offer');
});

test('Save or Update is decided by comparing the typed password; the page report has exact keys and bounds', () => {
  assert.equal(samePassword(Buffer.from('test-password-123'), Buffer.from('test-password-123')), true);
  assert.equal(samePassword(Buffer.from('test-password-123'), Buffer.from('test-password-456')), false);
  assert.equal(samePassword(Buffer.from('short'), Buffer.from('longer-password')), false);
  assert.equal(samePassword('test-password-123', Buffer.from('test-password-123')), false, 'only Buffers are compared');
  assert.equal(samePassword(null, Buffer.from('x')), false);
  const report = { nonce: 'n', offerId: 'offer-1', origin: 'https://login.test', username: ' ada@example.test ', password: 'test-pässword-123' };
  const valid = validOfferReport(report);
  assert.ok(Buffer.isBuffer(valid.password), 'the password is a Buffer the main process can wipe');
  assert.equal(valid.password.toString('utf8'), 'test-pässword-123');
  assert.deepEqual({ ...valid, password: null }, { offerId: 'offer-1', origin: 'https://login.test', username: 'ada@example.test', password: null });
  assert.throws(() => validOfferReport({ ...report, digest: { key: 'a', mac: 'b' } }), code('INVALID_ARGUMENT'), 'no extra keys');
  assert.throws(() => validOfferReport({ ...report, password: '' }), code('INVALID_ARGUMENT'));
  assert.throws(() => validOfferReport({ ...report, password: 'x'.repeat(1025) }), code('INVALID_ARGUMENT'));
  assert.throws(() => validOfferReport({ ...report, password: 'a\0b' }), code('INVALID_ARGUMENT'));
  assert.throws(() => validOfferReport({ ...report, password: 12345678 }), code('INVALID_ARGUMENT'));
  assert.throws(() => validOfferReport({ nonce: 'n', offerId: 'offer-1', origin: 'https://login.test', username: 'a' }), code('INVALID_ARGUMENT'), 'a report without a password is refused');
  assert.throws(() => validOfferReport({ ...report, username: 'a\nb' }), code('INVALID_ARGUMENT'));
  assert.throws(() => validOfferReport({ ...report, offerId: '../x' }), code('INVALID_ARGUMENT'));
  assert.equal(validOfferReport({ ...report, password: 'x'.repeat(1024) }).password.length, 1024);
});

test('a held offer outlives the page, is one per tab, and its password is wiped on every way out', () => {
  let clock = 1_000, changes = 0; const timers = new Map(); let nextTimer = 0;
  const holder = createOfferHolder({ lifetimeMs: 120_000, max: 3, now: () => clock, onChange: () => { changes += 1; },
    setTimer: (run, ms) => { const id = ++nextTimer; timers.set(id, { run, at: clock + ms }); return id; }, clearTimer: id => timers.delete(id) });
  const secret = text => Buffer.from(text), wiped = buffer => buffer.every(byte => byte === 0);
  const offer = (n, over = {}) => ({ offerId: 'offer-' + n, workspaceId: 'a', tabId: 'tab-' + n, origin: 'https://login.test', username: 'ada', kind: 'save', password: secret('pw-' + n), ...over });

  // Held: the view never has the password, and nothing about the page's document is needed to keep it.
  const first = offer(1);
  assert.equal(holder.hold(first), true);
  assert.deepEqual(holder.view('a'), { offerId: 'offer-1', kind: 'save', tabId: 'tab-1', origin: 'https://login.test', username: 'ada', expiresAt: 121_000 });
  assert.ok(!JSON.stringify(holder.view('a')).includes('pw-1'));
  assert.equal(holder.view('b'), null, 'another workspace never sees it');

  // Save: taken once, with the password, by the workspace it belongs to only. The caller wipes it.
  assert.throws(() => holder.take('offer-1', 'b'), code('OFFER_EXPIRED'));
  const taken = holder.take('offer-1', 'a');
  assert.equal(taken.password.toString(), 'pw-1'); assert.equal(taken.timer, undefined);
  assert.throws(() => holder.take('offer-1', 'a'), code('OFFER_EXPIRED'), 'only once');
  assert.equal(holder.size(), 0); assert.equal(timers.size, 0, 'its timer is cleared');

  // Not now / Never: wiped, and what comes back has no password.
  const second = offer(2); holder.hold(second);
  assert.throws(() => holder.drop('offer-2', 'b'), code('OFFER_EXPIRED'));
  const dropped = holder.drop('offer-2', 'a');
  assert.ok(wiped(second.password)); assert.equal(dropped.password, undefined); assert.equal(dropped.origin, 'https://login.test');

  // A newer sign-in in the same tab replaces the older one, which is wiped.
  const older = offer(3), newer = offer(4, { tabId: 'tab-3' });
  holder.hold(older); holder.hold(newer);
  assert.ok(wiped(older.password)); assert.equal(holder.view('a').offerId, 'offer-4'); assert.equal(holder.size(), 1);

  // The tab closed: swept and wiped.
  assert.equal(holder.sweep(item => item.tabId !== 'tab-3'), 1);
  assert.ok(wiped(newer.password)); assert.equal(holder.view('a'), null);

  // Two minutes: the timer wipes it and tells the shell; an expired offer can't be taken even before the timer runs.
  const timed = offer(5); holder.hold(timed);
  clock += 120_000;
  assert.equal(holder.view('a'), null); assert.throws(() => holder.take('offer-5', 'a'), code('OFFER_EXPIRED'));
  const before = changes; for (const timer of [...timers.values()]) timer.run();
  assert.ok(wiped(timed.password)); assert.equal(changes, before + 1); assert.equal(holder.size(), 0);

  // Full: a new offer is refused and its password wiped at once. Not a Buffer: refused.
  const kept = [6, 7, 8].map(n => offer(n)); kept.forEach(item => holder.hold(item));
  const extra = offer(9);
  assert.equal(holder.hold(extra), false); assert.ok(wiped(extra.password)); assert.equal(holder.size(), 3);
  assert.throws(() => holder.hold(offer(10, { password: 'a string' })), code('INVALID_ARGUMENT'));

  // Quit: everything wiped.
  holder.clear();
  assert.ok(kept.every(item => wiped(item.password))); assert.equal(holder.size(), 0); assert.equal(timers.size, 0);
});

test('the "never for this site" list is per workspace, exact origins, 0600, and editable', async t => {
  const directory = path.join(await folder(t, 'vn-'), 'logins');
  const never = createNeverSaveList({ directory });
  assert.deepEqual(never.add('a', 'https://login.test/'), { added: true });
  assert.deepEqual(never.add('a', 'https://login.test'), { added: false });
  assert.deepEqual(never.list('a'), ['https://login.test']); assert.deepEqual(never.list('b'), []);
  assert.throws(() => never.add('a', 'http://plain.test'), code('LOGIN_SITE_INVALID'));
  const file = path.join(directory, 'never-save.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(createNeverSaveList({ directory }).list('a'), ['https://login.test']);
  assert.deepEqual(never.remove('a', 'https://login.test'), { removed: true });
  assert.deepEqual(never.list('a'), []);
  fs.writeFileSync(file, '{"format":"x"}', { mode: 0o600 });
  const damaged = createNeverSaveList({ directory });
  assert.equal(damaged.damaged(), true);
  assert.throws(() => damaged.add('a', 'https://login.test'), code('NEVER_LIST_DAMAGED'));
});

// ── Which agents could use a login ──

test('the Vault says which agents could use a login now, in enforcement order', () => {
  const login = { loginId: 'login-1', origin: 'https://login.test', agentUse: true, state: 'ready' };
  const workspace = { id: 'a', kind: 'project' };
  const connection = (over = {}) => ({ agentSessionId: 'session-1', clientName: 'Builder', workspaceId: 'a', status: 'connected', workspaceActive: true,
    logins: true, mode: 'control', origins: ['https://login.test'], startedBy: 'owner', ...over });
  const one = (over, options = {}) => agentAccessForLogin({ ...login, ...(options.login ?? {}) }, { workspace, connections: [connection(over)], ...options }).agents[0];
  assert.deepEqual([one({}).can, one({}).why], ['asks', 'It may ask. You confirm its first use.']);
  assert.match(one({ logins: false }).why, /did not allow it to use saved logins/);
  assert.match(one({ mode: 'observe' }).why, /view-only/);
  assert.match(one({}, { login: { agentUse: false } }).why, /is off/);
  assert.match(one({ origins: ['https://other.test'] }).why, /not one of the sites/);
  assert.match(one({}, { paused: true }).why, /paused/);
  assert.match(one({}, { login: { state: 'needs-password' } }).why, /no longer has this password/);
  assert.equal(one({}, { signInStatus: () => 'allowed-session' }).can, 'yes');
  assert.equal(one({}, { signInStatus: () => 'denied' }).can, 'no');
  assert.equal(one({}, { signInStatus: () => 'pending' }).can, 'asks');
  assert.equal(agentAccessForLogin(login, { workspace, connections: [connection({ workspaceId: 'b' })] }).agents.length, 0, 'other workspaces\' agents are not listed');
  assert.equal(agentAccessForLogin(login, { workspace, connections: [connection({ workspaceActive: false })] }).summary, 'No agent is connected to this workspace right now.');
  assert.match(agentAccessForLogin(login, { workspace: { id: 'p', kind: 'personal' }, connections: [connection({ workspaceId: 'p' })] }).summary, /never work in your personal workspace/);
  assert.equal(agentAccessForLogin(login, { workspace, connections: [connection(), connection({ agentSessionId: 's2', logins: false })] }).summary, '1 agent could use this login now.');
  assert.equal(one({ clientName: 'Evil‮Name' }).name, 'Evil Name', 'agent names are plain text');
});

test('search and grouping by site; activity names you or the agent', () => {
  const logins = [{ loginId: '1', origin: 'https://b.test', username: 'zed', label: 'B' }, { loginId: '2', origin: 'https://a.test', username: 'amy', label: 'A' },
    { loginId: '3', origin: 'https://b.test', username: 'abe', label: 'B' }];
  assert.deepEqual(groupLoginsBySite(logins).map(group => [group.host, group.logins.map(item => item.loginId)]), [['a.test', ['2']], ['b.test', ['3', '1']]]);
  assert.deepEqual(searchLogins(logins, 'B.TE').map(item => item.loginId), ['1', '3']);
  assert.deepEqual(searchLogins(logins, 'amy').map(item => item.loginId), ['2']);
  assert.equal(searchLogins(logins, '').length, 3);
  assert.equal(activityWho(owner), 'You');
  assert.equal(activityWho(agent('Claude Code')), 'Claude Code');
});
