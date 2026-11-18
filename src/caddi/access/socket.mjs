import net from 'node:net';
import { lstatSync, realpathSync, chmodSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, PROTOCOL_VERSION, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
function absent(path) { try { lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }

/** Existing parent must be private and owned. No stale path is ever deleted/reused. */
export function validateSocketPath(socketPath) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') fail('UNSUPPORTED_PLATFORM', 'Unix socket transport is required.');
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0') || /[\u0000-\u001f\u007f]/u.test(socketPath)) fail('SOCKET_PATH_INVALID', 'Socket path is invalid.');
  const absolute = resolve(socketPath);
  if (absolute !== socketPath || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u.test(basename(absolute)) ||
      Buffer.byteLength(absolute) > 100) fail('SOCKET_PATH_INVALID', 'Socket path is invalid or too long.');
  const parent = dirname(absolute);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); } catch { fail('SOCKET_DIRECTORY_INVALID', 'Socket parent is unavailable.'); }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('SOCKET_DIRECTORY_INVALID', 'Socket parents must be real directories.');
    if (![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000))))
      fail('SOCKET_DIRECTORY_INVALID', 'Socket ancestors must not permit untrusted replacement.');
  }
  const info = lstatSync(parent);
  if (realpathSync(parent) !== parent || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) fail('SOCKET_DIRECTORY_INVALID', 'Socket parent must be owned with mode 0700.');
  if (!absent(absolute)) fail('SOCKET_EXISTS', 'Socket destination already exists.');
  return absolute;
}

/**
 * Native NDJSON transport, not an MCP server. Pairing is injected; no credential
 * file, environment-token, auto-pairing or insecure production fallback exists.
 */
export async function createUnixBroker({
  socketPath, audience, pairingProvider, handler, onDisconnect = () => {}, testOnly = false,
  maxFrameBytes = 65_536, maxResponseBytes = 1_048_576, maxConnections = 32,
  maxInflightPerConnection = 8, maxPendingHandlers = 128, authenticationTimeoutMs = 5_000,
  requestTimeoutMs = 30_000, idleTimeoutMs = 60_000,
} = {}) {
  assertId(audience, 'audience');
  if (typeof handler !== 'function' || typeof onDisconnect !== 'function') fail('INVALID_ARGUMENT', 'A request handler is required.');
  if (!pairingProvider || typeof pairingProvider.authenticate !== 'function' || typeof pairingProvider.isCurrent !== 'function' ||
      typeof pairingProvider.subscribeRevocation !== 'function' ||
      !(pairingProvider.protection === 'os-protected' || (testOnly === true && pairingProvider.protection === 'ephemeral-fixture')))
    fail('PAIRING_PROVIDER_REQUIRED', 'An OS-protected pairing provider is required.');
  for (const [key, value, maximum] of [
    ['maxFrameBytes', maxFrameBytes, 1_048_576], ['maxResponseBytes', maxResponseBytes, 4_194_304],
    ['maxConnections', maxConnections, 128], ['maxInflightPerConnection', maxInflightPerConnection, 64],
    ['maxPendingHandlers', maxPendingHandlers, 1024], ['authenticationTimeoutMs', authenticationTimeoutMs, 30_000],
    ['requestTimeoutMs', requestTimeoutMs, 60_000], ['idleTimeoutMs', idleTimeoutMs, 300_000],
  ]) assertInteger(value, key, { min: 1, max: maximum });
  const selectedPath = validateSocketPath(socketPath);
  const clients = new Set();
  let closed = false, pendingHandlers = 0, pendingAuthentication = 0;
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  function connection(socket) {
    if (closed || clients.size >= maxConnections || pendingAuthentication >= maxConnections) { socket.destroy(); return; }
    const lifetime = new AbortController();
    const client = { socket, context: null, check: null };
    clients.add(client);
    let phase = 'unauthenticated', buffer = Buffer.alloc(0);
    const requests = new Map(), usedIds = new Set();
    let expiryTimer;
    const authenticationTimer = setTimeout(() => rejectConnection('AUTHENTICATION_FAILED'), authenticationTimeoutMs);
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => {}); // Do not log credentials, request bodies or provider errors.
    function send(message, beforeWrite) {
      if (socket.destroyed) return false;
      let bytes;
      try {
        bytes = Buffer.from(JSON.stringify(cloneData(message, { maxBytes: maxResponseBytes })) + '\n');
        if (bytes.length > maxResponseBytes || socket.writableLength + bytes.length > maxResponseBytes * 2) { socket.destroy(); return false; }
      } catch { socket.destroy(); return false; }
      // Validate after serialization and immediately before write, without an await.
      // A failed guard drops the encoded sensitive reply; the caller sends a receipt only.
      try { beforeWrite?.(); } catch (error) { bytes.fill(0); throw error; }
      try { socket.write(bytes); return true; } catch { socket.destroy(); return false; }
    }
    function rejectConnection(code) {
      if (!socket.destroyed) {
        send({ type: 'error', code });
        socket.end();
        const destroyTimer = setTimeout(() => socket.destroy(), 50);
        destroyTimer.unref();
      }
      phase = 'closed';
      lifetime.abort(new CaddiError(code, 'Connection rejected.'));
    }
    socket.once('close', () => {
      phase = 'closed';
      clearTimeout(authenticationTimer);
      clearTimeout(expiryTimer);
      lifetime.abort(new CaddiError('CONNECTION_CLOSED', 'Connection closed.'));
      for (const request of requests.values()) request.abort(new CaddiError('CONNECTION_CLOSED', 'Connection closed.'));
      requests.clear();
      buffer = Buffer.alloc(0);
      clients.delete(client);
      if (client.context) { try { onDisconnect(client.context.connectionId); } catch { /* Authority is already invalidated. */ } }
    });

    async function authenticate(message) {
      try {
        assertKeys(message, ['type', 'protocolVersion', 'credential'], ['type', 'protocolVersion', 'credential']);
        if (message.protocolVersion !== PROTOCOL_VERSION || typeof message.credential !== 'string' ||
            !/^[A-Za-z0-9_-]{32,256}$/u.test(message.credential)) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        phase = 'authenticating';
        pendingAuthentication++;
        let verified;
        try { verified = await pairingProvider.authenticate({ credential: message.credential, audience, signal: lifetime.signal }); }
        finally { pendingAuthentication--; }
        if (phase === 'closed' || lifetime.signal.aborted) return;
        assertKeys(verified, ['authenticationId', 'principalId', 'agentSessionId', 'expiresAt'], ['authenticationId', 'principalId', 'agentSessionId', 'expiresAt']);
        for (const key of ['authenticationId', 'principalId', 'agentSessionId']) assertId(verified[key], key);
        assertInteger(verified.expiresAt, 'authentication expiry', { min: Date.now() + 1, max: Date.now() + 86_400_000 });
        const auth = Object.freeze({ ...verified, audience });
        client.check = () => !closed && phase === 'authenticated' && !lifetime.signal.aborted &&
          auth.expiresAt > Date.now() && pairingProvider.isCurrent(auth) === true;
        client.context = Object.freeze({
          principalId: auth.principalId, agentSessionId: auth.agentSessionId,
          connectionId: randomUUID(), expiresAt: auth.expiresAt,
          assertCurrent() {
            try { if (client.check()) return true; } catch { /* Fail closed. */ }
            fail('AUTHENTICATION_FAILED', 'Authentication failed.');
          },
        });
        phase = 'authenticated';
        client.context.assertCurrent();
        clearTimeout(authenticationTimer);
        expiryTimer = setTimeout(() => rejectConnection('AUTHENTICATION_FAILED'), auth.expiresAt - Date.now());
        send({ type: 'authenticated', protocolVersion: PROTOCOL_VERSION, connectionId: client.context.connectionId,
          agentSessionId: auth.agentSessionId, expiresAt: auth.expiresAt });
      } catch { rejectConnection('AUTHENTICATION_FAILED'); }
    }

    function runRequest(message) {
      let requestId;
      try {
        client.context.assertCurrent();
        assertKeys(message, ['type', 'requestId', 'body'], ['type', 'requestId', 'body']);
        requestId = assertId(message.requestId, 'requestId');
        if (usedIds.has(requestId)) fail('DUPLICATE_REQUEST', 'Request ID was already used.');
        if (usedIds.size >= 4096 || requests.size >= maxInflightPerConnection || pendingHandlers >= maxPendingHandlers) fail('REQUEST_CAPACITY', 'Request capacity reached.');
        const body = cloneData(message.body, { maxBytes: maxFrameBytes });
        assertInteger(body.deadlineAt, 'deadlineAt', { min: Date.now() + 1, max: Date.now() + requestTimeoutMs });
        if (['principalId', 'connectionId', 'agentSessionId', 'authenticationId'].some(key => Object.hasOwn(body, key))) fail('INVALID_ARGUMENT', 'Authority is not a request field.');
        usedIds.add(requestId);
        const controller = new AbortController();
        requests.set(requestId, controller);
        pendingHandlers++;
        let sent = false;
        const replyGuards = [];
        const registerReplyGuard = check => {
          if (sent || controller.signal.aborted || lifetime.signal.aborted || typeof check !== 'function' || replyGuards.length >= 8)
            fail('REPLY_GUARD_INVALID', 'A bounded synchronous reply guard is required.');
          replyGuards.push(check);
        };
        const respond = result => {
          if (sent || lifetime.signal.aborted) return;
          sent = true;
          try { client.context.assertCurrent(); }
          catch { rejectConnection('AUTHENTICATION_FAILED'); return; }
          try {
            send({ type: 'response', requestId, result }, () => {
              client.context.assertCurrent();
              const receiptOnly = ['rejected', 'cancelled', 'outcome-unknown'].includes(result?.status) &&
                /^[A-Z][A-Z0-9_]{0,63}$/u.test(result?.code) && Object.keys(result).every(key => key === 'status' || key === 'code');
              if (receiptOnly) return;
              if (controller.signal.aborted || body.deadlineAt <= Date.now() || !replyGuards.length)
                fail('RESPONSE_INVALIDATED', 'Response authority changed.');
              for (const check of replyGuards) {
                const verdict = check();
                if (verdict !== true) {
                  if (verdict instanceof Promise) verdict.catch(() => {});
                  fail('RESPONSE_INVALIDATED', 'Response authority changed.');
                }
              }
              client.context.assertCurrent();
              if (controller.signal.aborted || body.deadlineAt <= Date.now()) fail('RESPONSE_INVALIDATED', 'Response authority changed.');
            });
          } catch {
            try { client.context.assertCurrent(); }
            catch { rejectConnection('AUTHENTICATION_FAILED'); return; }
            send({ type: 'response', requestId, result: { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' } });
          }
        };
        const onAbort = () => respond({ status: 'outcome-unknown', code: controller.signal.reason?.code === 'DEADLINE' ? 'DEADLINE' : 'CANCELLED' });
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new CaddiError('DEADLINE', 'Request deadline passed.')), body.deadlineAt - Date.now());
        Promise.resolve().then(() => {
          client.context.assertCurrent();
          if (controller.signal.aborted) throw new CaddiError('CANCELLED', 'Request cancelled.');
          return handler(client.context, body, { signal: controller.signal, requestId, registerReplyGuard });
        }).then(respond, () => respond({ status: 'rejected', code: 'OPERATION_FAILED' })).finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          requests.delete(requestId);
          pendingHandlers--;
        });
      } catch (error) {
        send({ type: 'error', ...(requestId ? { requestId } : {}), code: ['DUPLICATE_REQUEST', 'REQUEST_CAPACITY'].includes(error.code) ? error.code : 'REQUEST_REJECTED' });
      }
    }

    function consume(bytes) {
      let message;
      try {
        if (!bytes.length || bytes.length > maxFrameBytes) throw new Error();
        message = JSON.parse(utf8.decode(bytes));
        assertKeys(message, ['type', 'protocolVersion', 'credential', 'requestId', 'body'], ['type']);
      } catch { rejectConnection('INVALID_FRAME'); return; }
      if (phase === 'unauthenticated') {
        if (message.type !== 'authenticate') { rejectConnection('AUTHENTICATION_REQUIRED'); return; }
        void authenticate(message);
      } else if (phase === 'authenticated') {
        if (message.type === 'request') runRequest(message);
        else if (message.type === 'cancel') {
          try {
            assertKeys(message, ['type', 'requestId'], ['type', 'requestId']);
            client.context.assertCurrent();
            const requestId = assertId(message.requestId, 'requestId');
            requests.get(requestId)?.abort(new CaddiError('CANCELLED', 'Request cancelled.'));
          } catch { rejectConnection('INVALID_FRAME'); }
        } else rejectConnection('INVALID_FRAME');
      } else if (phase !== 'closed') rejectConnection('INVALID_FRAME'); // No pre-auth pipelining.
    }
    socket.on('data', chunk => {
      if (phase === 'closed') return;
      buffer = Buffer.concat([buffer, chunk]);
      while (phase !== 'closed') {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        if (newline > maxFrameBytes) { rejectConnection('FRAME_LIMIT'); break; }
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        consume(frame);
      }
      if (buffer.length > maxFrameBytes) rejectConnection('FRAME_LIMIT');
    });
    socket.resume();
  }

  const server = net.createServer({ pauseOnConnect: true }, connection);
  const unsubscribe = pairingProvider.subscribeRevocation(() => {
    for (const client of clients) {
      try { if (client.check?.()) continue; } catch { /* Revoke below. */ }
      client.socket.destroy();
    }
  });
  if (typeof unsubscribe !== 'function') fail('PAIRING_PROVIDER_REQUIRED', 'Pairing revocation subscription is required.');
  try {
    await new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen({ path: selectedPath }, () => { server.off('error', reject); resolveListening(); });
    });
    const info = lstatSync(selectedPath);
    if (!info.isSocket() || info.uid !== process.getuid()) fail('SOCKET_BIND_FAILED', 'Socket binding is not owned.');
    chmodSync(selectedPath, 0o600);
    if ((lstatSync(selectedPath).mode & 0o777) !== 0o600) fail('SOCKET_BIND_FAILED', 'Socket mode was not applied.');
  } catch (error) {
    closed = true;
    unsubscribe();
    for (const client of clients) client.socket.destroy();
    if (server.listening) await new Promise(resolveClosed => server.close(resolveClosed));
    throw error instanceof CaddiError ? error : new CaddiError('SOCKET_BIND_FAILED', 'Socket could not be bound.');
  }
  server.on('error', () => { for (const client of clients) client.socket.destroy(); });
  return Object.freeze({
    socketPath: selectedPath, protocolVersion: PROTOCOL_VERSION,
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const client of clients) client.socket.destroy();
      await new Promise(resolveClosed => server.close(resolveClosed));
    },
  });
}
