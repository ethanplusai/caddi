import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CaddiError } from '../contracts.mjs';

// One-click setup for coding tools. Caddi only ever adds, replaces or removes
// its own `caddi` entry in a tool's MCP settings. It never reads a tool's
// sign-in or credential files, and connecting a tool grants it nothing: the
// tool must still ask, and the owner must still approve it on screen.
const SERVER = 'caddi';
const fail = (code, message) => { throw new CaddiError(code, message); };
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Tools Caddi knows how to set up. `kind: 'json'` tools keep MCP servers in a
 * JSON file under `mcpServers`; `kind: 'opencode'` keeps them under
 * `mcp.servers` in its own shape; `kind: 'cli'` tools are changed through
 * their own command so their file format stays theirs. */
export const AGENT_TOOLS = Object.freeze([
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', binary: 'claude', configFile: ['.claude.json'], marker: ['.claude'] },
  { id: 'codex', name: 'Codex', kind: 'cli', binary: 'codex', configFile: ['.codex', 'config.toml'], marker: ['.codex'] },
  { id: 'cursor', name: 'Cursor', kind: 'json', configFile: ['.cursor', 'mcp.json'], marker: ['.cursor'] },
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json',
    configFile: ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'], marker: ['Library', 'Application Support', 'Claude'] },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'json', configFile: ['.gemini', 'settings.json'], marker: ['.gemini'] },
  { id: 'windsurf', name: 'Windsurf', kind: 'json', configFile: ['.codeium', 'windsurf', 'mcp_config.json'], marker: ['.codeium', 'windsurf'] },
  { id: 'opencode', name: 'OpenCode', kind: 'opencode', binary: 'opencode', configFile: ['.config', 'opencode', 'opencode.json'],
    alternateConfigFile: ['.config', 'opencode', 'opencode.jsonc'], marker: ['.config', 'opencode'] },
].map(Object.freeze));
const byId = new Map(AGENT_TOOLS.map(tool => [tool.id, tool]));

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validEnv = env => env === undefined || (isObject(env) && Object.keys(env).length <= 8 &&
  Object.entries(env).every(([key, value]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(key) && typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)));
const validEntry = entry => isObject(entry) && typeof entry.command === 'string' && entry.command.length > 0 && entry.command.length <= 4096 &&
  Array.isArray(entry.args) && entry.args.length <= 32 &&
  entry.args.every(value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)) && validEnv(entry.env);

function readJsonConfig(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail('AGENT_TOOL_CONFIG_INVALID', 'The tool settings file cannot be changed safely');
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: {} };
    if (error instanceof CaddiError) throw error;
    fail('AGENT_TOOL_CONFIG_UNREADABLE', 'The tool settings file could not be read');
  }
  if (text.trim() === '') return { exists: true, value: {} };
  let value;
  try { value = JSON.parse(text); } catch { fail('AGENT_TOOL_CONFIG_INVALID', 'The tool settings file is not valid JSON, so Caddi left it alone'); }
  if (!isObject(value) || (value.mcpServers !== undefined && !isObject(value.mcpServers)) ||
      (value.mcp !== undefined && !isObject(value.mcp)) || (value.mcp?.servers !== undefined && !isObject(value.mcp.servers)))
    fail('AGENT_TOOL_CONFIG_INVALID', 'The tool settings file has an unexpected shape, so Caddi left it alone');
  return { exists: true, value };
}

/** Write through a temporary file in the same directory, keeping one backup of
 * the file as it was before Caddi first changed it. A symlinked settings file
 * is followed so the link itself is preserved. */
function writeJsonConfig(file, value, existed) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = target + '.caddi-backup';
  if (existed && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.caddi-' + process.pid + '-' + Date.now());
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch {}
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    fail('AGENT_TOOL_CONFIG_UNWRITABLE', 'The tool settings file could not be updated');
  }
}

/** Finder-launched apps get a short PATH, so also look where these tools are
 * usually installed. Only existence is checked; nothing is executed here. */
export function findBinary(name, { home, env = {}, exists = fs.existsSync, list = dir => fs.readdirSync(dir) } = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return null;
  const directories = [...String(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, 'bin')];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try { for (const version of list(nvm).sort().reverse()) directories.push(path.join(nvm, version, 'bin')); } catch {}
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { if (exists(candidate)) return candidate; } catch {}
  }
  return null;
}

const defaultRun = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true, ...options },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(String(stdout ?? '')));
});

/**
 * @param {object} options
 * @param {() => ({command: string, args: string[]} | null)} options.entry Current stable MCP entry, or null when
 *   Caddi has no address that survives a restart.
 */
export function createAgentTools({ home = os.homedir(), env = process.env, entry, run = defaultRun, onChange = () => {} } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || typeof entry !== 'function') fail('AGENT_TOOLS_UNAVAILABLE', 'Agent tool setup is unavailable');
  const at = parts => path.join(home, ...parts);
  let cache = null, busy = false;

  function entryFor(tool) {
    const current = entry();
    if (!validEntry(current)) fail('AGENT_TOOL_ADDRESS_UNAVAILABLE', 'Caddi has no stable connection address yet. Try again in a moment.');
    // Each tool announces itself by name, so the approval request says which one is asking.
    const args = [...current.args], index = args.indexOf('--name');
    if (index >= 0 && index + 1 < args.length) args[index + 1] = tool.name; else args.push('--name', tool.name);
    return { command: current.command, args, ...(current.env ? { env: { ...current.env } } : {}) };
  }

  // OpenCode reads opencode.json or opencode.jsonc. Use whichever is already there.
  function fileFor(tool) {
    const main = at(tool.configFile);
    if (tool.alternateConfigFile && !fs.existsSync(main) && fs.existsSync(at(tool.alternateConfigFile))) return at(tool.alternateConfigFile);
    return main;
  }

  function connected(tool) {
    try {
      if (tool.id === 'codex') {
        const text = fs.readFileSync(at(tool.configFile), 'utf8');
        return /^\s*\[mcp_servers\.(?:caddi|"caddi")\]\s*$/m.test(text);
      }
      const { value } = readJsonConfig(fileFor(tool));
      if (tool.kind === 'opencode') return isObject(value.mcp?.servers) && isObject(value.mcp.servers[SERVER]);
      return isObject(value.mcpServers) && isObject(value.mcpServers[SERVER]);
    } catch { return false; }
  }

  /** The program a tool's caddi entry starts and the client script it runs, or nulls when they cannot be read. */
  function entryProgram(tool) {
    const scriptOf = args => Array.isArray(args) ? args.find(arg => typeof arg === 'string' && arg.endsWith('.mjs')) ?? null : null;
    try {
      if (tool.id === 'codex') {
        const text = fs.readFileSync(at(tool.configFile), 'utf8');
        const section = text.split(/^\s*\[mcp_servers\.(?:caddi|"caddi")\]\s*$/m)[1]?.split(/^\s*\[/m)[0] ?? '';
        const found = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(section);
        const list = /^\s*args\s*=\s*\[(.*)\]\s*$/m.exec(section);
        const args = list ? [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => JSON.parse('"' + match[1] + '"')) : [];
        return { command: found ? JSON.parse('"' + found[1] + '"') : null, script: scriptOf(args) };
      }
      const { value } = readJsonConfig(fileFor(tool));
      const entry = tool.kind === 'opencode' ? value.mcp?.servers?.[SERVER] : value.mcpServers?.[SERVER];
      const command = tool.kind === 'opencode' ? entry?.command?.[0] : entry?.command;
      const args = tool.kind === 'opencode' ? entry?.command?.slice?.(1) : entry?.args;
      return { command: typeof command === 'string' ? command : null, script: scriptOf(args) };
    } catch { return { command: null, script: null }; }
  }
  /** Set up, but for a copy of Caddi that is no longer there (moved to Applications, run from its disk image,
   * or updated to a version whose client script has a different name). */
  function stale(tool) {
    const { command, script } = entryProgram(tool);
    try {
      if (command && path.isAbsolute(command) && !fs.existsSync(command)) return true;
      if (!script || !path.isAbsolute(script) || fs.existsSync(script)) return false;
      let current = null;
      try { current = entry(); } catch {}
      return !(validEntry(current) && current.args.includes(script));
    } catch { return false; }
  }

  function inspect(tool) {
    const binary = tool.binary ? findBinary(tool.binary, { home, env }) : null;
    let present = false;
    try { present = fs.existsSync(at(tool.marker)); } catch {}
    // A command-line tool needs its command; a desktop app only needs its settings folder.
    const installed = tool.kind === 'cli' ? !!binary : present || !!binary;
    const isConnected = installed && connected(tool);
    return { id: tool.id, name: tool.name, installed, connected: isConnected, stale: isConnected && stale(tool), binary };
  }

  const publicView = item => ({ id: item.id, name: item.name, installed: item.installed, connected: item.connected, stale: item.stale === true });
  function refresh() { cache = AGENT_TOOLS.map(inspect); return cache.map(publicView); }
  function list() { return (cache ?? (refresh(), cache)).map(publicView); }

  async function change(toolId, work) {
    const tool = byId.get(toolId);
    if (!tool) fail('AGENT_TOOL_UNKNOWN', 'That coding tool is not supported');
    if (busy) fail('AGENT_TOOL_BUSY', 'Another tool is being set up. Try again in a moment.');
    busy = true;
    try {
      const state = inspect(tool);
      if (!state.installed) fail('AGENT_TOOL_NOT_INSTALLED', tool.name + ' was not found on this Mac');
      await work(tool, state);
    } finally { busy = false; refresh(); try { onChange(); } catch {} }
    return list().find(item => item.id === toolId);
  }

  async function command(tool, state, args) {
    try { return await run(state.binary, args, { cwd: home, env: { ...env, NO_COLOR: '1' } }); }
    catch { fail('AGENT_TOOL_COMMAND_FAILED', tool.name + ' did not accept the change. Use Copy configuration instead.'); }
  }

  return Object.freeze({
    list, refresh,
    connect: toolId => change(toolId, async (tool, state) => {
      const server = entryFor(tool);
      if (tool.kind === 'json') {
        const file = at(tool.configFile), { exists, value } = readJsonConfig(file);
        writeJsonConfig(file, { ...value, mcpServers: { ...(value.mcpServers ?? {}), [SERVER]: server } }, exists);
      } else if (tool.kind === 'opencode') {
        const file = fileFor(tool), { exists, value } = readJsonConfig(file);
        const local = { type: 'local', command: [server.command, ...server.args], ...(server.env ? { environment: server.env } : {}) };
        writeJsonConfig(file, { ...value, mcp: { ...(value.mcp ?? {}), servers: { ...(value.mcp?.servers ?? {}), [SERVER]: local } } }, exists);
      } else if (tool.id === 'claude-code') {
        if (state.connected) await run(state.binary, ['mcp', 'remove', '--scope', 'user', SERVER], { cwd: home, env }).catch(() => {});
        await command(tool, state, ['mcp', 'add-json', '--scope', 'user', SERVER, JSON.stringify({ type: 'stdio', ...server })]);
      } else {
        if (state.connected) await run(state.binary, ['mcp', 'remove', SERVER], { cwd: home, env }).catch(() => {});
        const env = Object.entries(server.env ?? {}).flatMap(([key, value]) => ['--env', key + '=' + value]);
        await command(tool, state, ['mcp', 'add', SERVER, ...env, '--', server.command, ...server.args]);
      }
      if (!connected(tool)) fail('AGENT_TOOL_COMMAND_FAILED', tool.name + ' did not keep the change. Use Copy configuration instead.');
    }),
    disconnect: toolId => change(toolId, async (tool, state) => {
      if (!state.connected) return;
      if (tool.kind === 'json') {
        const file = at(tool.configFile), { exists, value } = readJsonConfig(file);
        const { [SERVER]: _removed, ...rest } = value.mcpServers ?? {};
        writeJsonConfig(file, { ...value, mcpServers: rest }, exists);
      } else if (tool.kind === 'opencode') {
        const file = fileFor(tool), { exists, value } = readJsonConfig(file);
        const { [SERVER]: _removed, ...rest } = value.mcp?.servers ?? {};
        writeJsonConfig(file, { ...value, mcp: { ...(value.mcp ?? {}), servers: rest } }, exists);
      } else if (tool.id === 'claude-code') await command(tool, state, ['mcp', 'remove', '--scope', 'user', SERVER]);
      else await command(tool, state, ['mcp', 'remove', SERVER]);
    }),
  });
}
