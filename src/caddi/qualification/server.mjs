import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { CaddiError, assertKeys, assertInteger, cloneData } from '../contracts.mjs';
import { FIXTURE_ROUTES, renderFixturePage, workerSource } from './pages.mjs';

export const QUALIFICATION_LIMITS = Object.freeze({ uploadBytes: 1048576, downloadBytes: 1048576, formBytes: 4096, headerBytes: 8192, connections: 64, sessions: 512, requestMs: 5000, downloadDelayMs: 100 });
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new HttpError(status, code); };
const exactQuery = (url, keys) => { for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'INVALID_QUERY'); };
function integerParameter(url, key, fallback, max) {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(400, 'INVALID_QUERY');
  return Number(value);
}
async function bodyBytes(request, limit) {
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail(415, 'ENCODING_UNSUPPORTED');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) fail(413, 'BODY_LIMIT');
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, done = false;
    const finish = (error, value) => {
      if (done) return; done = true;
      request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', broken);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => { length += chunk.length; if (length > limit) finish(new HttpError(413, 'BODY_LIMIT')); else chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish(new HttpError(499, 'REQUEST_ABORTED'));
    const broken = () => finish(new HttpError(400, 'REQUEST_BROKEN'));
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', broken);
    if (request.aborted) aborted();
  });
}
async function bodyRecord(request) {
  const bytes = await bodyBytes(request, QUALIFICATION_LIMITS.formBytes);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'INVALID_UTF8'); }
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    try { const parsed = cloneData(JSON.parse(text), { maxBytes: QUALIFICATION_LIMITS.formBytes }); assertKeys(parsed, Object.keys(parsed)); return parsed; }
    catch { fail(400, 'INVALID_BODY'); }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const parameters = new URLSearchParams(text), result = {};
    for (const key of parameters.keys()) {
      if (!/^[a-z][a-zA-Z]{0,31}$/.test(key) || Object.hasOwn(result, key) || parameters.getAll(key).length !== 1 || ['constructor', 'prototype'].includes(key)) fail(400, 'INVALID_BODY');
      result[key] = parameters.get(key);
    }
    return result;
  }
  fail(415, 'CONTENT_TYPE_UNSUPPORTED');
}
function closedFields(record, fields) {
  try { assertKeys(record, fields, fields); } catch { fail(400, 'INVALID_BODY'); }
}

/** Synthetic local HTTP fixtures only. No browser launch or filesystem access. */
export async function startQualificationFixtures(options = {}) {
  assertKeys(options, ['port', 'sessionTtlMs', 'maxSessions', 'durationMs', 'now']);
  const { port = 0, sessionTtlMs = 60000, maxSessions = 256, durationMs = 1800000, now = Date.now } = options;
  assertInteger(port, 'port', { max: 65535 });
  assertInteger(sessionTtlMs, 'sessionTtlMs', { min: 100, max: 300000 });
  assertInteger(maxSessions, 'maxSessions', { min: 1, max: QUALIFICATION_LIMITS.sessions });
  assertInteger(durationMs, 'durationMs', { min: 1000, max: 7200000 });
  if (typeof now !== 'function') throw new CaddiError('INVALID_ARGUMENT', 'Invalid fixture clock');
  const serverId = randomBytes(8).toString('hex'), cookieName = 'caddi_fixture_' + serverId;
  const sessions = new Map(), accountCounters = { alpha: 0, beta: 0 }, activeResponses = new Set();
  const counts = { requests: 0, uploadsStarted: 0, uploadsCompleted: 0, uploadsAborted: 0, downloadsStarted: 0, downloadsCompleted: 0, downloadsCancelled: 0, intentionalErrors: 0 };
  let origin = '', stopping = null, lifetimeTimer;
  const timestamp = () => { const value = now(); assertInteger(value, 'fixture time'); return value; };
  const prune = () => { const time = timestamp(); for (const [token, session] of sessions) if (session.expiresAt <= time) sessions.delete(token); };
  const increment = key => { counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1); };
  function cookieToken(request) {
    const matches = String(request.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(cookieName.length + 1); return /^[a-f0-9]{48}$/.test(token) ? token : null;
  }
  function sessionFor(request) { prune(); return sessions.get(cookieToken(request)) ?? null; }
  function cookie(value, maxAge) { return cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge; }
  function checkTransport(request) {
    const headerCount = name => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length;
    if (request.socket.remoteAddress !== '127.0.0.1' || headerCount('host') !== 1 || request.headers.host !== new URL(origin).host) fail(421, 'HOST_REJECTED');
    if (headerCount('origin') > 1 || (request.headers.origin !== undefined && request.headers.origin !== origin)) fail(403, 'ORIGIN_REJECTED');
    if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'CROSS_SITE_REJECTED');
    if (request.method === 'POST' && request.headers.origin !== origin) fail(403, 'ORIGIN_REQUIRED');
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'METHOD_UNSUPPORTED');
    if (!request.url || request.url.length > 4096 || !request.url.startsWith('/') || request.url.startsWith('//') || /[\\\u0000-\u0020]/u.test(request.url)) fail(400, 'INVALID_URL');
  }
  function headers(response, nonce = null) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'" + (nonce ? " 'nonce-" + nonce + "'" : '') + "; style-src 'self'" + (nonce ? " 'nonce-" + nonce + "'" : '') + "; img-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'");
  }
  function json(response, status, data) {
    if (response.destroyed || response.writableEnded) return;
    const body = Buffer.from(JSON.stringify(data)); headers(response);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }); response.end(body);
  }
  function page(response, route, context = {}) {
    const rendered = renderFixturePage(route, { serverId, ...context });
    if (!rendered) fail(404, 'NOT_FOUND');
    headers(response, rendered.nonce);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(rendered.html) }); response.end(rendered.html);
  }
  function download(request, response, url) {
    exactQuery(url, ['bytes', 'delayMs', 'error']);
    if (url.searchParams.has('error')) {
      if (url.searchParams.get('error') !== '1') fail(400, 'INVALID_QUERY');
      increment('intentionalErrors'); return json(response, 503, { fixture: true, code: 'INTENTIONAL_DOWNLOAD_FAILURE' });
    }
    const bytes = integerParameter(url, 'bytes', 16384, QUALIFICATION_LIMITS.downloadBytes);
    const delay = integerParameter(url, 'delayMs', 0, QUALIFICATION_LIMITS.downloadDelayMs);
    let remaining = bytes, timer, completed = false;
    increment('downloadsStarted'); headers(response);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Content-Disposition': 'attachment; filename="caddi-synthetic-fixture.bin"' });
    response.once('finish', () => { completed = true; increment('downloadsCompleted'); });
    response.once('close', () => { clearTimeout(timer); if (!completed) increment('downloadsCancelled'); });
    const chunk = Buffer.alloc(32768, 0x4f);
    const send = () => {
      if (response.destroyed) return;
      if (!remaining) { response.end(); return; }
      const size = Math.min(chunk.length, remaining); remaining -= size;
      const writable = response.write(chunk.subarray(0, size));
      if (!remaining) { response.end(); return; }
      if (!writable) response.once('drain', () => { timer = setTimeout(send, delay); });
      else timer = setTimeout(send, delay);
    };
    send();
  }
  async function handle(request, response) {
    increment('requests'); checkTransport(request);
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && url.pathname === '/health') {
      exactQuery(url, []); return json(response, 200, { fixture: true, serverId, nativeQualified: false });
    }
    if (request.method === 'GET' && url.pathname === '/download') return download(request, response, url);
    if (request.method === 'GET' && url.pathname === '/api/session') {
      exactQuery(url, []); const session = sessionFor(request);
      return json(response, 200, session ? { authenticated: true, account: session.account, expiresAt: session.expiresAt, sharedAccountCounter: accountCounters[session.account] } : { authenticated: false });
    }
    if (request.method === 'GET' && url.pathname === '/offline/sw.js') {
      exactQuery(url, []); const source = workerSource(serverId); headers(response); response.setHeader('Service-Worker-Allowed', '/offline/');
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(source) }); response.end(source); return;
    }
    if (request.method === 'GET' && url.pathname === '/offline/network') {
      exactQuery(url, []); return json(response, 200, { fixture: true, serverId, networkOnly: true, time: timestamp() });
    }
    if (request.method === 'GET' && FIXTURE_ROUTES.includes(url.pathname)) {
      exactQuery(url, url.pathname === '/frame' ? ['opaque'] : url.pathname === '/spa' ? ['replaced'] : []);
      return page(response, url.pathname);
    }
    if (request.method !== 'POST') fail(404, 'NOT_FOUND');
    exactQuery(url, []);
    if (url.pathname === '/api/upload') {
      if (String(request.headers['content-type'] ?? '').split(';')[0] !== 'application/octet-stream') fail(415, 'CONTENT_TYPE_UNSUPPORTED');
      increment('uploadsStarted');
      let bytes;
      try { bytes = await bodyBytes(request, QUALIFICATION_LIMITS.uploadBytes); }
      catch (error) { if (error.code === 'REQUEST_ABORTED') increment('uploadsAborted'); throw error; }
      increment('uploadsCompleted');
      return json(response, 200, { fixture: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), stored: false });
    }
    const record = await bodyRecord(request);
    if (url.pathname === '/api/login') {
      closedFields(record, ['account']);
      if (!['alpha', 'beta'].includes(record.account)) fail(400, 'SYNTHETIC_ACCOUNT_ONLY');
      prune(); const previous = cookieToken(request);
      if (previous) sessions.delete(previous);
      if (sessions.size >= maxSessions) fail(429, 'SESSION_LIMIT');
      const token = randomBytes(24).toString('hex'), expiresAt = timestamp() + sessionTtlMs;
      assertInteger(expiresAt, 'fixture expiry');
      sessions.set(token, { account: record.account, expiresAt }); response.setHeader('Set-Cookie', cookie(token, Math.ceil(sessionTtlMs / 1000)));
      return json(response, 200, { fixture: true, authenticated: true, account: record.account, expiresAt });
    }
    if (['/api/logout', '/api/expire'].includes(url.pathname)) {
      closedFields(record, []); const token = cookieToken(request);
      if (token) sessions.delete(token);
      response.setHeader('Set-Cookie', cookie('', 0)); return json(response, 200, { fixture: true, authenticated: false });
    }
    if (url.pathname === '/api/account-action') {
      closedFields(record, ['action']); if (record.action !== 'advance') fail(400, 'INVALID_BODY');
      const session = sessionFor(request); if (!session) fail(401, 'SESSION_REQUIRED');
      if (accountCounters[session.account] >= 1024) fail(429, 'COUNTER_LIMIT');
      accountCounters[session.account]++;
      return json(response, 200, { fixture: true, account: session.account, sharedAccountCounter: accountCounters[session.account] });
    }
    if (url.pathname === '/popup/receive') {
      closedFields(record, ['message']);
      if (typeof record.message !== 'string' || record.message.length > 200 || /[\u0000-\u001f\u007f]/u.test(record.message)) fail(400, 'INVALID_BODY');
      return page(response, url.pathname, { message: record.message });
    }
    fail(404, 'NOT_FOUND');
  }
  const server = http.createServer({ maxHeaderSize: QUALIFICATION_LIMITS.headerBytes }, (request, response) => {
    if (activeResponses.size >= QUALIFICATION_LIMITS.connections) {
      response.setHeader('Connection', 'close'); request.resume();
      json(response, 503, { fixture: true, code: 'REQUEST_CAPACITY' }); return;
    }
    activeResponses.add(response);
    const deadline = setTimeout(() => response.destroy(), QUALIFICATION_LIMITS.requestMs);
    deadline.unref();
    response.once('close', () => { clearTimeout(deadline); activeResponses.delete(response); });
    handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      if (error.code === 'REQUEST_ABORTED' || request.aborted) return;
      response.setHeader('Connection', 'close');
      const reply = () => {
        if (response.destroyed || response.writableEnded) return;
        json(response, error instanceof HttpError ? error.status : 500, { fixture: true, code: error instanceof HttpError ? error.code : 'FIXTURE_FAILURE' });
      };
      // Read the rest of a rejected body before replying. Closing while the client is still
      // sending resets the connection, and the client sees ECONNRESET instead of the status.
      // The request deadline above still bounds how long this can take.
      if (request.complete) reply();
      else { request.once('end', reply); request.resume(); }
    });
  });
  server.maxConnections = QUALIFICATION_LIMITS.connections;
  server.maxRequestsPerSocket = 100; server.requestTimeout = QUALIFICATION_LIMITS.requestMs;
  server.headersTimeout = 2000; server.keepAliveTimeout = 1000; server.setTimeout(QUALIFICATION_LIMITS.requestMs, socket => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); origin = 'http://127.0.0.1:' + server.address().port; resolve(); });
  });
  function stop() {
    if (!stopping) {
      clearTimeout(lifetimeTimer); sessions.clear();
      stopping = new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    return stopping;
  }
  lifetimeTimer = setTimeout(() => { stop().catch(() => {}); }, durationMs); lifetimeTimer.unref();
  return Object.freeze({ origin, serverId, cookieName, stop, metrics() { prune(); return Object.freeze({ ...counts, activeSessions: sessions.size, activeRequests: activeResponses.size, listening: server.listening }); } });
}
