// "Import logins…" in the Vault: a CSV exported from another password manager, read once in the main process,
// parsed strictly in memory, reviewed by the owner before anything is stored. The format is recognised from the
// header row alone. Passwords stay in Buffers held by the main process until the owner imports or cancels; the
// review the shell sees has sites and usernames only.
import fs from 'node:fs';
import { CaddiError } from '../contracts.mjs';
import { usableLoginOrigin, LOGIN_LIMITS } from './logins.mjs';

export const IMPORT_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, rows: 5000, columns: 64, fieldChars: 65_536, headerChars: 128 });
const fail = (code, message = 'The file could not be imported') => { throw new CaddiError(code, message); };

/**
 * The export formats Caddi recognises, by their header row (compared case-insensitively, in any order).
 * `verified` says how sure we are of the exact headers: 'documented' when the vendor's own documentation
 * or a widely published sample shows them; 'unverified' when written from memory and not checked against
 * a fresh export. Extra columns are ignored; every listed `required` column must be present.
 */
export const IMPORT_FORMATS = Object.freeze([
  Object.freeze({ id: 'bitwarden', label: 'Bitwarden', verified: 'documented',
    headers: ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'],
    required: ['type', 'name', 'login_uri', 'login_username', 'login_password'],
    columns: { title: 'name', url: 'login_uri', username: 'login_username', password: 'login_password', type: 'type' } }),
  Object.freeze({ id: 'lastpass', label: 'LastPass', verified: 'documented',
    headers: ['url', 'username', 'password', 'totp', 'extra', 'name', 'grouping', 'fav'],
    required: ['url', 'username', 'password', 'extra', 'name', 'grouping'],
    columns: { title: 'name', url: 'url', username: 'username', password: 'password' } }),
  Object.freeze({ id: 'dashlane', label: 'Dashlane', verified: 'unverified',
    headers: ['username', 'username2', 'username3', 'title', 'password', 'note', 'url', 'category', 'otpsecret'],
    required: ['username', 'username2', 'title', 'password', 'url'],
    columns: { title: 'title', url: 'url', username: 'username', password: 'password' } }),
  Object.freeze({ id: '1password', label: '1Password', verified: 'unverified',
    headers: ['title', 'url', 'username', 'password', 'otpauth', 'favorite', 'archived', 'tags', 'notes'],
    required: ['title', 'url', 'username', 'password', 'archived'],
    columns: { title: 'title', url: 'url', username: 'username', password: 'password' } }),
  Object.freeze({ id: 'apple', label: 'Apple Passwords or Safari', verified: 'documented',
    headers: ['title', 'url', 'username', 'password', 'notes', 'otpauth'],
    required: ['title', 'url', 'username', 'password', 'otpauth'],
    columns: { title: 'title', url: 'url', username: 'username', password: 'password' } }),
  Object.freeze({ id: 'chrome', label: 'Chrome, Edge or Brave', verified: 'documented',
    headers: ['name', 'url', 'username', 'password', 'note'],
    required: ['name', 'url', 'username', 'password'],
    columns: { title: 'name', url: 'url', username: 'username', password: 'password' } }),
]);
// A plain url, username, password file from anywhere else.
const GENERIC = Object.freeze({ id: 'generic', label: 'A CSV with url, username and password columns', verified: 'documented' });
const GENERIC_NAMES = Object.freeze({ url: ['url', 'website', 'site', 'uri', 'login_uri', 'web site', 'login url'],
  username: ['username', 'user name', 'login', 'login_username', 'user', 'email', 'e-mail'],
  password: ['password', 'login_password', 'pass'], title: ['title', 'name', 'label'] });

/**
 * RFC 4180 CSV, strictly: comma separated, fields optionally in double quotes with "" for a quote, line breaks
 * inside quotes kept, CRLF or LF row ends, one leading UTF-8 BOM removed. Refused: a quote inside an unquoted
 * field, text after a closing quote, an unterminated quote, NUL, more columns or rows or characters than the limits.
 */
export function parseCsv(text, limits = IMPORT_LIMITS) {
  if (typeof text !== 'string') fail('IMPORT_FILE_INVALID');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\0')) fail('IMPORT_FILE_INVALID', 'The file contains NUL characters, so it is not a CSV export');
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false, i = 0, fieldStarted = false;
  const endField = () => {
    if (field.length > limits.fieldChars) fail('IMPORT_FIELD_TOO_LONG');
    row.push(field); field = ''; afterQuote = false; fieldStarted = false;
    if (row.length > limits.columns) fail('IMPORT_TOO_MANY_COLUMNS');
  };
  const endRow = () => {
    endField();
    // A completely empty line is skipped, as every exporter's trailing newline produces one.
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > limits.rows + 1) fail('IMPORT_TOO_MANY_ROWS');
    }
    row = [];
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; afterQuote = true; i++; continue;
      }
      field += char; i++;
      if (field.length > limits.fieldChars) fail('IMPORT_FIELD_TOO_LONG');
      continue;
    }
    if (char === ',') { endField(); i++; continue; }
    if (char === '\r' || char === '\n') {
      endRow();
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (afterQuote) fail('IMPORT_FILE_INVALID', 'A quoted field is followed by other text');
    if (char === '"') {
      if (fieldStarted || field.length) fail('IMPORT_FILE_INVALID', 'A quote appears inside an unquoted field');
      quoted = true; fieldStarted = true; i++; continue;
    }
    field += char; fieldStarted = true; i++;
    if (field.length > limits.fieldChars) fail('IMPORT_FIELD_TOO_LONG');
  }
  if (quoted) fail('IMPORT_FILE_INVALID', 'A quoted field is not closed');
  if (field.length || fieldStarted || afterQuote || row.length) endRow();
  if (!rows.length) fail('IMPORT_EMPTY');
  return { header: rows[0], rows: rows.slice(1) };
}

const headerName = value => String(value).trim().toLowerCase();
/** The export format, from the header row only. Null when it is not a login export Caddi knows. */
export function detectImportFormat(header) {
  if (!Array.isArray(header) || !header.length || header.length > IMPORT_LIMITS.columns) return null;
  const names = header.map(headerName);
  if (names.some(name => name.length > IMPORT_LIMITS.headerChars) || new Set(names).size !== names.length) return null;
  const has = name => names.includes(name), index = name => names.indexOf(name);
  for (const format of IMPORT_FORMATS) {
    if (!format.required.every(has)) continue;
    // Chrome's header is a subset of nothing else; 1Password and Apple share four columns, told apart by "archived".
    if (format.id === 'apple' && has('archived')) continue;
    if (format.id === 'chrome' && (has('title') || has('extra'))) continue;
    return { id: format.id, label: format.label, verified: format.verified,
      columns: Object.fromEntries(Object.entries(format.columns).map(([key, name]) => [key, index(name)])) };
  }
  const pick = key => GENERIC_NAMES[key].map(index).find(position => position >= 0) ?? -1;
  const columns = { url: pick('url'), username: pick('username'), password: pick('password'), title: pick('title') };
  if (columns.url >= 0 && columns.password >= 0) return { id: GENERIC.id, label: GENERIC.label, verified: GENERIC.verified, columns };
  return null;
}

/** The https origin a login is saved for, from an exported URL. Bare host names are read as https. */
export function importOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(text)) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text); } catch { return null; }
  if (url.username || url.password) return null;
  const origin = url.origin;
  return origin !== 'null' && usableLoginOrigin(origin) ? origin : null;
}
const controlCharacters = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/u;

/**
 * Turns parsed rows into candidates: site, username, title and password (a Buffer), or a reason to skip.
 * Reasons: not-a-login (a card or note row), missing-site, no-https-origin, missing-password, too-long, invalid-text, malformed-row.
 */
export function importCandidates({ header, rows }, format) {
  if (!format) fail('IMPORT_FORMAT_UNKNOWN', 'The first row is not a header Caddi recognises');
  const width = header.length, { columns } = format;
  const get = (row, key) => columns[key] >= 0 ? row[columns[key]] ?? '' : '';
  return rows.map((row, position) => {
    const base = { rowId: 'row-' + (position + 1), line: position + 2, origin: null, site: '', username: '', title: '', password: null, skip: null };
    if (row.length !== width) return { ...base, skip: 'malformed-row' };
    if (format.id === 'bitwarden' && get(row, 'type').trim().toLowerCase() !== 'login') return { ...base, title: clip(get(row, 'title')), skip: 'not-a-login' };
    const url = get(row, 'url').trim(), username = get(row, 'username').trim(), title = get(row, 'title').trim(), password = get(row, 'password');
    const shown = { ...base, site: clip(url, 200), username: clip(username, LOGIN_LIMITS.username), title: clip(title, LOGIN_LIMITS.label) };
    if (!url) return { ...shown, skip: 'missing-site' };
    const origin = importOrigin(url);
    if (!origin) return { ...shown, skip: 'no-https-origin' };
    const site = new URL(origin).host;
    if (!password) return { ...shown, origin, site, skip: 'missing-password' };
    if (password.length > LOGIN_LIMITS.password || username.length > LOGIN_LIMITS.username) return { ...shown, origin, site, skip: 'too-long' };
    if (controlCharacters.test(username) || controlCharacters.test(title) || password.includes('\0')) return { ...shown, origin, site, skip: 'invalid-text' };
    return { ...shown, origin, site, password: Buffer.from(password, 'utf8') };
  });
}
const clip = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/gu, ' ').trim().slice(0, max);

export const IMPORT_SKIP_REASONS = Object.freeze({
  'not-a-login': 'Not a website login (a card, note or identity).',
  'missing-site': 'No website address.',
  'no-https-origin': 'Not an https website, so Caddi will not fill it.',
  'missing-password': 'No password.',
  'too-long': 'The username or password is longer than Caddi keeps.',
  'invalid-text': 'The username or name contains control characters.',
  'malformed-row': 'The row has a different number of columns from the header.',
  'duplicate-in-file': 'The same site and username appear earlier in the file.',
  'already-saved': 'This workspace already has a login for this site and username.',
  'over-limit': 'Caddi keeps at most 500 logins.',
});

/**
 * The review for one workspace, before anything is stored. `existing` is that workspace's logins (origin and
 * username), `capacity` how many more logins Caddi may keep. Each row says it will be imported or why not.
 */
export function reviewImport(candidates, { existing = [], capacity = LOGIN_LIMITS.logins } = {}) {
  const seen = new Set(), saved = new Set(existing.map(item => item.origin + '\n' + item.username));
  let room = Math.max(0, capacity);
  const rows = candidates.map(item => {
    const view = { rowId: item.rowId, line: item.line, site: item.site, origin: item.origin, username: item.username, title: item.title };
    if (item.skip) return { ...view, status: 'skip', reason: item.skip };
    const key = item.origin + '\n' + item.username;
    if (seen.has(key)) return { ...view, status: 'skip', reason: 'duplicate-in-file' };
    seen.add(key);
    if (saved.has(key)) return { ...view, status: 'skip', reason: 'already-saved' };
    if (room <= 0) return { ...view, status: 'skip', reason: 'over-limit' };
    room--;
    return { ...view, status: 'ready', reason: null };
  });
  return { rows, ready: rows.filter(row => row.status === 'ready').length, skipped: rows.filter(row => row.status === 'skip').length };
}

/** Reads the chosen file once: a regular file, not a link, at most the size limit, valid UTF-8. */
export function readImportFile(file) {
  if (typeof file !== 'string' || !file.startsWith('/') || file.length > 4096) fail('IMPORT_FILE_UNAVAILABLE');
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { fail('IMPORT_FILE_UNAVAILABLE'); }
  let bytes;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail('IMPORT_FILE_UNAVAILABLE');
    if (stat.size > IMPORT_LIMITS.bytes) fail('IMPORT_FILE_TOO_LARGE');
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read; }
    if (offset !== stat.size || fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) fail('IMPORT_FILE_CHANGED');
  } finally { fs.closeSync(descriptor); }
  try { return decodeImport(bytes); } finally { bytes.fill(0); }
}
export function decodeImport(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > IMPORT_LIMITS.bytes) fail('IMPORT_FILE_TOO_LARGE');
  if (!bytes.length) fail('IMPORT_EMPTY');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { fail('IMPORT_FILE_INVALID', 'The file is not UTF-8 text'); }
}

/** File to candidates in one step, for the main process and the tests. */
export function prepareImport(text) {
  const parsed = parseCsv(text), format = detectImportFormat(parsed.header);
  if (!format) fail('IMPORT_FORMAT_UNKNOWN', 'The first row is not a header Caddi recognises');
  if (!parsed.rows.length) fail('IMPORT_EMPTY');
  return { format, candidates: importCandidates(parsed, format) };
}
/** Wipes every password Buffer of an import. */
export function wipeCandidates(candidates) { for (const item of candidates ?? []) item.password?.fill(0); }
