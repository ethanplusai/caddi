import path from 'node:path';
import { CaddiError, assertId } from '../contracts.mjs';
import { assertDesktopRendezvousPublication } from '../access/rendezvous.mjs';

const fail = () => { throw new CaddiError('RENDEZVOUS_UNAVAILABLE', 'The stable local connection address is unavailable'); };
const codeFor = value => /^[A-Z][A-Z0-9_]{1,63}$/.test(value?.code ?? '') ? value.code : 'RENDEZVOUS_UNAVAILABLE';
const absolute = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) && path.isAbsolute(value) && path.resolve(value) === value;

/** Main-owned endpoint presentation. A published address never carries pairing
 * credentials or restores authority; the client still enrolls on each runtime. */
const validRuntime = value => value === null || (typeof value === 'object' && absolute(value.command) &&
  value.env && typeof value.env === 'object' && Object.entries(value.env).length <= 8 &&
  Object.entries(value.env).every(([key, item]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(key) && typeof item === 'string' && item.length <= 256));

/** @param {{command: string, env: Record<string, string>} | null} [options.runtime] How a coding tool should start the
 *   client. A packaged app passes its own executable so nobody has to install Node.js; null means plain `node`. */
export function createDesktopConnectionConfig({ projectRoot, descriptorPath, access, runtime = null, onChange = () => {} } = {}) {
  if (!validRuntime(runtime)) fail();
  if (!absolute(projectRoot) || !absolute(descriptorPath) || !absolute(access?.enrollmentSocket) ||
      typeof access?.assertEnrollmentCurrent !== 'function' || typeof onChange !== 'function') fail();
  const runtimeId = assertId(access.enrollmentRuntimeId), socketPath = access.enrollmentSocket;
  const script = path.join(projectRoot, 'scripts/caddi-desktop-client.mjs');
  let publication = null, unavailableCode = null;
  const emit = () => { try { onChange(); } catch {} };
  function active() {
    const result = access.assertEnrollmentCurrent();
    if (result !== true && result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); fail(); }
    if (access.enrollmentRuntimeId !== runtimeId || access.enrollmentSocket !== socketPath) fail();
  }
  function checked(value) {
    active();
    const record = assertDesktopRendezvousPublication(value);
    if (record.runtimeId !== runtimeId || record.descriptorPath !== descriptorPath) fail();
    return record;
  }
  function snapshot() {
    const common = { requiresApproval: true, persistentAuthentication: false };
    try { active(); }
    catch (error) { return { connectionConfig: null, connectionSetup: { ...common, mode: 'temporary', status: 'unavailable', code: codeFor(error) } }; }
    let endpoint = ['--socket', socketPath], mode = 'temporary', status = unavailableCode ? 'unavailable' : 'not-configured';
    if (publication) {
      try { const record = checked(publication); endpoint = ['--rendezvous', record.descriptorPath]; mode = 'stable'; status = 'ready'; unavailableCode = null; }
      // A canceled Quit can restore the same live owner. Revalidate that exact
      // receipt without republishing; a replaced file or runtime still fails.
      catch (error) { unavailableCode = codeFor(error); status = 'unavailable'; }
    }
    const launch = runtime ? { command: runtime.command, args: [script, ...endpoint, '--name', 'Coding agent'],
      ...(Object.keys(runtime.env).length ? { env: { ...runtime.env } } : {}) }
      : { command: 'node', args: [script, ...endpoint, '--name', 'Coding agent'] };
    return { connectionConfig: { mcpServers: { caddi: launch } },
      connectionSetup: { ...common, mode, status, code: unavailableCode } };
  }
  return Object.freeze({
    snapshot,
    usePublication(value) { checked(value); publication = value; unavailableCode = null; emit(); return snapshot().connectionSetup; },
    unavailable(error) { publication = null; unavailableCode = codeFor(error); emit(); return snapshot().connectionSetup; },
  });
}
