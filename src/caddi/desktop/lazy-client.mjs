// The connection a coding tool's MCP process holds to Caddi, made on demand.
//
// A coding tool starts its MCP servers when it starts and gives each a short time to answer. Approval is a person's
// step and can take longer than that, so this client never makes the tool wait for it: the MCP session answers at
// once, and the request for approval goes out with the first tool call. Until the owner approves, each call returns
// a result that says so and carries the code to compare. A connection that ended (Caddi restarted, the session was
// revoked or ran out) is asked for again by the next call.
import { toBrokerRequest } from '../clients/mcp.mjs';

const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'CADDI_UNAVAILABLE';
// These mean the connection itself is gone, as opposed to one request failing.
const GONE = new Set(['BROKER_DISCONNECTED', 'BROKER_ENDPOINT', 'BROKER_UNAVAILABLE', 'AUTH_REJECTED', 'AUTH_TIMEOUT', 'PAIRING_REQUIRED']);

export function pendingResult(clientName, comparisonCode) {
  return { status: 'refused', code: 'APPROVAL_PENDING', connection: 'pending', ...(comparisonCode ? { comparisonCode } : {}),
    message: 'Caddi is waiting for its owner to approve this connection. Tell them now: "Open Caddi and approve ' + clientName +
      (comparisonCode ? '. The code is ' + comparisonCode : '') + '." Then call the tool again. The request stays open for about 10 minutes; calling again after that makes a new one with a new code.' };
}
export function unavailableResult(code) {
  return { status: 'refused', code, connection: 'unavailable',
    message: code === 'CANCELLED' ? 'The connection was cancelled.' :
      'Caddi did not accept the connection (' + code + '). The owner may have closed Caddi, rejected the request or let it run out. Ask them to open Caddi, then call the tool again.' };
}

export function createLazyDesktopClient({ connect, clientName = 'Coding agent', waitMs = 20000, keepAliveMs = 45000, onPending = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
  if (typeof connect !== 'function') throw new TypeError('connect is required');
  let client = null, attempt = null, code = null, closed = false, keeper = null;

  function drop() {
    if (keeper) { clearRepeat(keeper); keeper = null; }
    const old = client; client = null;
    try { old?.close?.(); } catch {}
  }
  function begin() {
    if (attempt) return attempt;
    code = null;
    const mine = attempt = Promise.resolve().then(() => connect({ onPending(info) { code = info?.comparisonCode ?? null; try { onPending(info); } catch {} } })).then(connected => {
      if (attempt === mine) { attempt = null; code = null; }
      if (closed) { try { connected.close?.(); } catch {} return { error: 'CANCELLED' }; }
      client = connected;
      if (keepAliveMs > 0) {
        keeper = setRepeat(() => { connected.request(toBrokerRequest('caddi_workspaces', {}), { timeoutMs: 5000 }).catch(() => { if (client === connected) drop(); }); }, keepAliveMs);
        keeper?.unref?.();
      }
      return { client: connected };
    }, error => { if (attempt === mine) { attempt = null; code = null; } return { error: safeCode(error?.code) }; });
    return mine;
  }

  async function request(body, options = {}) {
    if (closed) return unavailableResult('CANCELLED');
    let current = client;
    if (!current) {
      let timer;
      const outcome = await Promise.race([begin(), new Promise(resolve => { timer = setTimer(() => resolve(null), waitMs); })]);
      clearTimer(timer);
      if (outcome === null) return pendingResult(clientName, code);
      if (outcome.error) return unavailableResult(outcome.error);
      current = outcome.client;
    }
    try { return await current.request(body, options); }
    catch (error) { if (GONE.has(error?.code) && client === current) drop(); throw error; }
  }
  function close() { if (closed) return; closed = true; drop(); }
  return Object.freeze({ request, close, get connected() { return !!client; } });
}
