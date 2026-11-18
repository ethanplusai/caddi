import net from 'node:net';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertRecord, assertInteger, cloneData, PROTOCOL_VERSION } from '../contracts.mjs';

const fail = (code, message) => new CaddiError(code, message);
export async function validateSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0') ||
      Buffer.byteLength(socketPath) > (process.platform === 'darwin' ? 103 : 107)) throw fail('BROKER_ENDPOINT', 'Invalid local broker path');
  const parent = path.dirname(socketPath);
  const [directory, socket] = await Promise.all([lstat(parent), lstat(socketPath)]);
  if (directory.isSymbolicLink() || socket.isSymbolicLink() || !directory.isDirectory() || !socket.isSocket() ||
      (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0 ||
      (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid())) ||
      await realpath(parent) !== parent) throw fail('BROKER_ENDPOINT', 'Broker endpoint is not private and owned');
  return socketPath;
}

export function createBrokerClient({ socketPath, credentialProvider, handshakeMs = 5000, maxFrameBytes = 1_048_576, maxPending = 32 } = {}) {
  if (typeof credentialProvider !== 'function') throw fail('PAIRING_REQUIRED', 'A private credential provider is required');
  assertInteger(handshakeMs, 'handshakeMs', { min: 1, max: 30000 });
  assertInteger(maxFrameBytes, 'maxFrameBytes', { min: 1024, max: 2_097_152 });
  assertInteger(maxPending, 'maxPending', { min: 1, max: 128 });
  let socket, connection, connecting, closed = false, authenticated = false, bytes = Buffer.alloc(0), handshakeReject, credentialAbort;
  const pending = new Map(), retired = new Set();
  function retire(id) { retired.add(id); if (retired.size > 256) retired.delete(retired.values().next().value); }
  function rejectAll(code = 'BROKER_DISCONNECTED') {
    for (const entry of pending.values()) entry.finish(fail(code, 'Broker connection ended'));
    pending.clear();
  }
  function shutdown(code = 'BROKER_DISCONNECTED') {
    if (closed) return;
    closed = true; authenticated = false; bytes = Buffer.alloc(0);
    credentialAbort?.abort();
    handshakeReject?.(fail(code, 'Broker connection ended'));
    rejectAll(code); socket?.destroy();
  }
  function send(frame) {
    if (!socket || socket.destroyed || closed) throw fail('BROKER_DISCONNECTED', 'Broker is disconnected');
    const serialized = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(serialized) > maxFrameBytes || socket.writableLength + Buffer.byteLength(serialized) > maxFrameBytes * 2) throw fail('CLIENT_LIMIT', 'Broker frame exceeds bounds');
    socket.write(serialized);
  }
  async function connect() {
    if (authenticated) return connection;
    if (closed) throw fail('BROKER_DISCONNECTED', 'Broker client is closed');
    if (connecting) return connecting;
    connecting = (async () => {
      await validateSocketPath(socketPath);
      if (closed) throw fail('BROKER_DISCONNECTED', 'Broker client is closed');
      credentialAbort = new AbortController();
      let providerTimer;
      let providerAbort;
      let credential;
      try {
        credential = await Promise.race([
          Promise.resolve().then(() => {
            if (closed || credentialAbort.signal.aborted) throw fail('BROKER_DISCONNECTED', 'Credential acquisition was cancelled');
            return credentialProvider({ signal: credentialAbort.signal });
          }),
          new Promise((_, reject) => {
            providerAbort = () => reject(fail(closed ? 'BROKER_DISCONNECTED' : 'AUTH_TIMEOUT', 'Credential acquisition ended'));
            credentialAbort.signal.addEventListener('abort', providerAbort, { once: true });
            if (closed) credentialAbort.abort();
            providerTimer = setTimeout(() => credentialAbort.abort(), handshakeMs);
          }),
        ]);
      } finally { clearTimeout(providerTimer); credentialAbort.signal.removeEventListener('abort', providerAbort); }
      if (closed) throw fail('BROKER_DISCONNECTED', 'Broker client is closed');
      if (typeof credential !== 'string' || !credential || Buffer.byteLength(credential) > 4096 || /[\r\n\0]/.test(credential)) throw fail('PAIRING_REQUIRED', 'Invalid pairing credential');
      try {
        return await new Promise((resolve, reject) => {
          handshakeReject = reject;
          const timer = setTimeout(() => shutdown('AUTH_TIMEOUT'), handshakeMs);
          timer.unref?.();
          socket = net.createConnection({ path: socketPath });
          const complete = value => { clearTimeout(timer); handshakeReject = null; resolve(value); };
          socket.once('connect', () => {
            try { send({ type: 'authenticate', protocolVersion: PROTOCOL_VERSION, credential }); }
            catch { shutdown('BROKER_PROTOCOL'); }
            finally { credential = null; }
          });
          socket.on('data', chunk => {
            try {
              bytes = Buffer.concat([bytes, chunk]);
              let newline;
              while ((newline = bytes.indexOf(10)) !== -1) {
                if (newline > maxFrameBytes) throw fail('BROKER_LIMIT', 'Broker response exceeds bounds');
                const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
                if (!line.length) throw fail('BROKER_PROTOCOL', 'Empty broker frame');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
                const message = cloneData(JSON.parse(text), { maxBytes: maxFrameBytes });
                assertRecord(message, 'broker response');
                if (!authenticated) {
                  if (message.type === 'error') { shutdown('AUTH_REJECTED'); return; }
                  if (message.type !== 'authenticated' || message.protocolVersion !== PROTOCOL_VERSION ||
                      typeof message.connectionId !== 'string' || typeof message.agentSessionId !== 'string' ||
                      !Number.isFinite(message.expiresAt) || message.expiresAt <= Date.now()) throw fail('BROKER_PROTOCOL', 'Invalid authentication response');
                  authenticated = true;
                  connection = Object.freeze({ connectionId: message.connectionId, agentSessionId: message.agentSessionId, expiresAt: message.expiresAt });
                  complete(connection); continue;
                }
                if (!['response', 'error'].includes(message.type) || typeof message.requestId !== 'string') throw fail('BROKER_PROTOCOL', 'Unexpected broker response');
                const entry = pending.get(message.requestId);
                if (!entry) { if (retired.has(message.requestId)) continue; throw fail('BROKER_PROTOCOL', 'Unknown broker request'); }
                if (message.type === 'error') entry.finish(fail(typeof message.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(message.code) ? message.code : 'BROKER_ERROR', 'Broker rejected request'));
                else entry.finish(null, cloneData(message.result, { maxBytes: maxFrameBytes }));
              }
              if (bytes.length > maxFrameBytes) throw fail('BROKER_LIMIT', 'Incomplete broker response exceeds bounds');
            } catch { shutdown('BROKER_PROTOCOL'); }
          });
          socket.on('error', () => { clearTimeout(timer); shutdown('BROKER_UNAVAILABLE'); });
          socket.on('close', () => { clearTimeout(timer); shutdown(); });
          socket.on('end', () => { clearTimeout(timer); shutdown(); });
        });
      } finally { credential = null; }
    })().catch(error => {
      const code = ['BROKER_ENDPOINT', 'BROKER_DISCONNECTED', 'PAIRING_REQUIRED', 'AUTH_TIMEOUT', 'AUTH_REJECTED', 'BROKER_PROTOCOL', 'BROKER_UNAVAILABLE'].includes(error.code) ? error.code : 'BROKER_UNAVAILABLE';
      shutdown(code); throw fail(code, 'Could not establish the private broker connection');
    });
    return connecting;
  }
  async function request(body, { signal, timeoutMs = 30000 } = {}) {
    assertInteger(timeoutMs, 'timeoutMs', { min: 1, max: 30000 });
    if (signal?.aborted) throw fail('CANCELLED', 'Request was cancelled');
    const data = cloneData(body, { maxBytes: 65536 });
    assertRecord(data, 'request');
    const connectingNow = connect();
    if (signal) {
      await new Promise((resolve, reject) => {
        const abortConnect = () => reject(fail('CANCELLED', 'Request cancelled before dispatch'));
        signal.addEventListener('abort', abortConnect, { once: true });
        if (signal.aborted) abortConnect();
        connectingNow.then(value => { signal.removeEventListener('abort', abortConnect); resolve(value); }, error => { signal.removeEventListener('abort', abortConnect); reject(error); });
      });
    } else await connectingNow;
    if (signal?.aborted) throw fail('CANCELLED', 'Request was cancelled');
    if (pending.size >= maxPending) throw fail('CLIENT_LIMIT', 'Too many pending requests');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let finished = false;
      const abort = () => cancel('CANCELLED');
      const finish = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        pending.delete(requestId); retire(requestId);
        if (error) reject(error); else resolve(result);
      };
      const cancel = code => {
        try { send({ type: 'cancel', requestId }); } catch {}
        finish(fail(code, 'Request stopped; a dispatched mutation may have an unknown outcome'));
      };
      const timer = setTimeout(() => cancel('CLIENT_TIMEOUT'), timeoutMs);
      timer.unref?.();
      pending.set(requestId, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { send({ type: 'request', requestId, body: data }); }
      catch (error) { finish(error); }
    });
  }
  return Object.freeze({ connect, request, close: () => shutdown(), get connection() { return connection; } });
}
