import net from 'node:net';
import { chmodSync, lstatSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { validateSocketPath as validateNewSocket } from '../access/socket.mjs';
import { validateSocketPath as validateExistingSocket } from '../clients/broker-client.mjs';
import { CaddiError, assertKeys, assertString, assertInteger, cloneData } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Local enrollment could not be completed'); };
const decoder = new TextDecoder('utf-8', { fatal: true });
const safeCode = code => /^[A-Z][A-Z0-9_]{0,63}$/.test(code ?? '') ? code : 'ENROLLMENT_REJECTED';
const runtimeIdValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

/** The request name is untrusted. Authority is issued only by the trusted UI. */
export async function createEnrollmentServer({ socketPath, runtimeId = randomUUID(), onChange = () => {}, approvalMs = 600000, maxPending = 8 } = {}) {
  assertInteger(approvalMs, 'approvalMs', { min: 20, max: 600000 });
  assertInteger(maxPending, 'maxPending', { min: 1, max: 32 });
  if (!runtimeIdValid(runtimeId)) fail('ENROLLMENT_PROTOCOL');
  validateNewSocket(socketPath);
  const pending = new Map(), sockets = new Set(), approvals = new Set();
  let closed = false;
  const changed = () => { try { onChange(); } catch {} };
  const server = net.createServer(socket => {
    if (closed || sockets.size >= maxPending) { socket.destroy(); return; }
    sockets.add(socket);
    let phase = 'new', bytes = Buffer.alloc(0), request, timer;
    const lifetime = new AbortController();
    function end(code) {
      if (phase === 'closed') return;
      phase = 'closed'; clearTimeout(timer);
      if (request) pending.delete(request.requestId);
      lifetime.abort();
      if (!socket.destroyed) {
        socket.end(JSON.stringify({ type: 'rejected', code: safeCode(code) }) + '\n');
        const destroy = setTimeout(() => socket.destroy(), 50); destroy.unref();
      }
      changed();
    }
    timer = setTimeout(() => end('ENROLLMENT_TIMEOUT'), 5000);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket); clearTimeout(timer); phase = 'closed'; lifetime.abort();
      if (request && pending.delete(request.requestId)) changed();
      bytes.fill(0); bytes = Buffer.alloc(0);
    });
    socket.on('data', chunk => {
      if (phase !== 'new') { end('ENROLLMENT_PROTOCOL'); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 2048) { end('ENROLLMENT_LIMIT'); return; }
      const newline = bytes.indexOf(10);
      if (newline === -1) return;
      if (newline !== bytes.length - 1) { end('ENROLLMENT_PROTOCOL'); return; }
      try {
        const value = cloneData(JSON.parse(decoder.decode(bytes.subarray(0, newline))), { maxBytes: 2048 });
        assertKeys(value, ['type', 'protocolVersion', 'clientName', 'runtimeId'], ['type', 'protocolVersion', 'clientName']);
        if (value.type !== 'enroll' || value.protocolVersion !== 1) fail('ENROLLMENT_PROTOCOL');
        if (Object.hasOwn(value, 'runtimeId') && value.runtimeId !== runtimeId) { end('ENROLLMENT_RUNTIME_CHANGED'); return; }
        assertString(value.clientName, 'clientName', { min: 1, max: 80 });
        if (/[\u0000-\u001f\u007f]/u.test(value.clientName)) fail('ENROLLMENT_PROTOCOL');
        const code = randomBytes(4).toString('hex').toUpperCase();
        request = {
          requestId: randomUUID(), comparisonCode: code.slice(0, 4) + '-' + code.slice(4),
          clientName: value.clientName, expiresAt: Date.now() + approvalMs,
          runtimeId: Object.hasOwn(value, 'runtimeId') ? runtimeId : null,
          socket, lifetime, end, setPhase(next) { phase = next; },
        };
        phase = 'waiting'; bytes.fill(0); bytes = Buffer.alloc(0);
        clearTimeout(timer); timer = setTimeout(() => end('ENROLLMENT_TIMEOUT'), approvalMs);
        pending.set(request.requestId, request);
        socket.write(JSON.stringify({ type: 'pending', requestId: request.requestId, comparisonCode: request.comparisonCode, expiresAt: request.expiresAt,
          ...(request.runtimeId ? { runtimeId } : {}) }) + '\n');
        changed();
      } catch { end('ENROLLMENT_PROTOCOL'); }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    const info = lstatSync(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid()) fail('ENROLLMENT_ENDPOINT');
    chmodSync(socketPath, 0o600);
    if ((lstatSync(socketPath).mode & 0o777) !== 0o600) fail('ENROLLMENT_ENDPOINT');
  } catch (error) {
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    throw error;
  }
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  const summary = item => ({
    requestId: item.requestId, comparisonCode: item.comparisonCode,
    clientName: item.clientName, nameVerified: false, expiresAt: item.expiresAt,
  });
  return Object.freeze({
    socketPath, runtimeId,
    pending: () => [...pending.values()].map(summary),
    reject(requestId) { const item = pending.get(requestId); if (!item) return false; item.end('HUMAN_REJECTED'); return true; },
    async approve({ requestId, comparisonCode }, issue, { assertCurrent = () => true } = {}) {
      if (typeof assertCurrent !== 'function') fail('ENROLLMENT_STALE');
      const ownerCurrent = () => { const result = assertCurrent(); if (result === false || result?.then) fail('ENROLLMENT_STALE'); };
      ownerCurrent();
      const item = pending.get(requestId);
      if (closed || !item || item.approving || item.expiresAt <= Date.now() || item.lifetime.signal.aborted ||
          item.comparisonCode !== comparisonCode || typeof issue !== 'function') fail('ENROLLMENT_STALE');
      item.approving = true; item.setPhase('approving');
      const operation = (async () => {
        let issued;
        try {
          issued = await issue({ ...summary(item), signal: item.lifetime.signal });
          if (closed || pending.get(requestId) !== item || item.socket.destroyed ||
              item.lifetime.signal.aborted || item.expiresAt <= Date.now()) fail('ENROLLMENT_STALE');
          const payload = cloneData({ type: 'approved', ...issued.reply, ...(item.runtimeId ? { runtimeId } : {}) }, { maxBytes: 4096 });
          const bytes = Buffer.from(JSON.stringify(payload) + '\n');
          if (item.socket.writableLength + bytes.length > 8192) { bytes.fill(0); fail('ENROLLMENT_LIMIT'); }
          // Recheck immediately before handing the credential to this exact socket.
          if (item.lifetime.signal.aborted || item.socket.destroyed) { bytes.fill(0); fail('ENROLLMENT_STALE'); }
          try { ownerCurrent(); } catch (error) { bytes.fill(0); throw error; }
          item.setPhase('approved');
          pending.delete(requestId);
          item.socket.end(bytes);
          issued.reply.credential = null;
          const result = issued.result;
          issued = null; changed();
          return result;
        } catch (error) {
          if (issued) { issued.reply.credential = null; await issued.revoke?.(); }
          item.end(safeCode(error.code));
          throw new CaddiError(safeCode(error.code), 'Local enrollment was not approved');
        }
      })();
      approvals.add(operation);
      try { return await operation; } finally { approvals.delete(operation); }
    },
    async close() {
      if (closed) return; closed = true;
      for (const item of pending.values()) item.end('ENROLLMENT_CLOSED');
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...approvals]);
      await new Promise(resolve => server.close(resolve));
    },
  });
}

/** Credentials are returned only in memory to the connecting process. */
export async function requestDesktopEnrollment({ socketPath, runtimeId = null, assertEndpointCurrent = () => true,
  clientName = 'Coding agent', onPending = () => {}, signal, timeoutMs = 605000 } = {}) {
  assertString(clientName, 'clientName', { min: 1, max: 80 });
  if (/[\u0000-\u001f\u007f]/u.test(clientName)) fail('ENROLLMENT_PROTOCOL');
  assertInteger(timeoutMs, 'timeoutMs', { min: 20, max: 610000 });
  if ((runtimeId !== null && !runtimeIdValid(runtimeId)) || typeof assertEndpointCurrent !== 'function') fail('ENROLLMENT_PROTOCOL');
  // This async fence checks locator freshness only; it cannot approve a session.
  const endpointCurrent = async () => {
    try { const value = await assertEndpointCurrent(); if (value !== true && value !== undefined) fail('ENROLLMENT_ENDPOINT'); }
    catch (error) { throw new CaddiError(safeCode(error.code), 'Local enrollment endpoint changed'); }
  };
  await validateExistingSocket(socketPath);
  await endpointCurrent();
  if (signal?.aborted) fail('CANCELLED');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = Buffer.alloc(0), done = false, phase = 'connecting';
    const finish = (error, result) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      bytes.fill(0); bytes = Buffer.alloc(0); socket.destroy();
      if (error) reject(new CaddiError(safeCode(error.code), 'Local enrollment failed')); else resolve(result);
    };
    const abort = () => finish({ code: 'CANCELLED' });
    const timer = setTimeout(() => finish({ code: 'ENROLLMENT_TIMEOUT' }), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on('connect', () => {
      void endpointCurrent().then(() => {
        if (!done) { phase = 'pending'; socket.write(JSON.stringify({ type: 'enroll', protocolVersion: 1, clientName,
          ...(runtimeId ? { runtimeId } : {}) }) + '\n'); }
      }, error => finish(error));
    });
    socket.on('error', () => finish({ code: 'ENROLLMENT_UNAVAILABLE' }));
    // A normal server ends its socket with the approval frame. Retain the bounded
    // final locator check after that EOF; never infer approval from EOF itself.
    socket.on('end', () => { if (!done && phase !== 'verifying') finish({ code: 'ENROLLMENT_CLOSED' }); });
    socket.on('close', () => { if (!done && phase !== 'verifying') finish({ code: 'ENROLLMENT_CLOSED' }); });
    socket.on('data', chunk => {
      if (done) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8192) { finish({ code: 'ENROLLMENT_LIMIT' }); return; }
      let newline;
      while (!done && (newline = bytes.indexOf(10)) !== -1) {
        try {
          const value = cloneData(JSON.parse(decoder.decode(bytes.subarray(0, newline))), { maxBytes: 4096 });
          bytes = bytes.subarray(newline + 1);
          if (value.type === 'rejected') { finish({ code: safeCode(value.code) }); return; }
          if (value.type === 'pending' && phase === 'pending') {
            assertKeys(value, ['type', 'requestId', 'comparisonCode', 'expiresAt', 'runtimeId'], ['type', 'requestId', 'comparisonCode', 'expiresAt']);
            if ((runtimeId && value.runtimeId !== runtimeId) || (!runtimeId && Object.hasOwn(value, 'runtimeId'))) fail('ENROLLMENT_PROTOCOL');
            if (!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(value.comparisonCode) || !Number.isSafeInteger(value.expiresAt)) fail('ENROLLMENT_PROTOCOL');
            phase = 'approval';
            onPending(Object.freeze({ requestId: value.requestId, comparisonCode: value.comparisonCode, expiresAt: value.expiresAt }));
          } else if (value.type === 'approved' && phase === 'approval') {
            assertKeys(value, ['type', 'brokerSocket', 'credential', 'runtimeId'], ['type', 'brokerSocket', 'credential']);
            if ((runtimeId && value.runtimeId !== runtimeId) || (!runtimeId && Object.hasOwn(value, 'runtimeId'))) fail('ENROLLMENT_PROTOCOL');
            if (typeof value.brokerSocket !== 'string' || typeof value.credential !== 'string' || value.credential.length !== 80) fail('ENROLLMENT_PROTOCOL');
            phase = 'verifying';
            const received = { brokerSocket: value.brokerSocket, credential: value.credential };
            void endpointCurrent().then(() => {
              if (done) { received.credential = null; return; }
              finish(null, received);
            }, error => { received.credential = null; finish(error); });
            if (bytes.length) finish({ code: 'ENROLLMENT_PROTOCOL' });
            return;
          } else fail('ENROLLMENT_PROTOCOL');
        } catch { finish({ code: 'ENROLLMENT_PROTOCOL' }); return; }
      }
    });
  });
}
