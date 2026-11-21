const approval = 'Compare the code in your coding tool and Caddi before approving this agent session. After a Caddi restart, approve again and choose its workspace and site access.';

/** The main process supplies the actual configuration. A stable address never
 * implies restored credentials, sessions, scopes, or automatic enrollment. */
export function agentSetupView(snapshot) {
  const unavailable = description => ({ mode: 'unavailable', available: false, status: 'Agent setup unavailable',
    description, approval: '', configText: '' });
  if (snapshot?.privateBrowsing) return unavailable('Agent setup is unavailable in a private window. Open a normal window to connect your coding tool.');
  const config = snapshot?.connectionConfig, entry = config?.mcpServers?.caddi, args = entry?.args;
  if (!config || typeof entry?.command !== 'string' || !Array.isArray(args) || args.some(value => typeof value !== 'string'))
    return unavailable('Caddi has no current agent configuration to copy. Wait for the browser connection to become available.');
  const setup = snapshot?.connectionSetup;
  const stable = setup?.mode === 'stable' && setup.status === 'ready' && setup.requiresApproval === true && setup.persistentAuthentication === false &&
    args.includes('--rendezvous') && !args.includes('--socket');
  const temporary = args.includes('--socket') && !args.includes('--rendezvous');
  if (!stable && !temporary) return unavailable('The current connection address is unavailable. Wait for Caddi to publish a current configuration.');
  let configText;
  try { configText = JSON.stringify(config, null, 2); } catch { return unavailable('The current agent configuration could not be displayed.'); }
  if (stable) return { mode: 'stable', available: true, status: 'Stable local connection',
    description: 'Copy this configuration into your coding tool. Reuse it after ordinary Caddi restarts.', approval, configText };
  const failedPublication = setup?.status === 'unavailable';
  return { mode: 'temporary', available: true,
    status: failedPublication ? 'Stable connection address unavailable' : 'Temporary connection address',
    description: failedPublication ? 'Use the temporary configuration below for this running session. Copy an updated configuration after restarting Caddi.' :
      'This configuration uses the current running session. Copy a new configuration after each Caddi restart.', approval, configText };
}

export function renderAgentSetup(snapshot, ownerDocument = document) {
  const view = agentSetupView(snapshot), $ = id => ownerDocument.getElementById(id);
  for (const [id, text] of [['agent-setup-status', view.status], ['agents-description', view.description],
    ['agent-setup-approval', view.approval], ['mcp-config', view.configText]]) if ($(id).textContent !== text) $(id).textContent = text;
  $('agent-setup-status').dataset.mode = view.mode;
  $('agent-setup-approval').hidden = !view.available;
  $('mcp-config').hidden = !view.available;
  $('copy-config').disabled = !view.available;
  return view;
}

const toolMessages = {
  AGENT_TOOL_ADDRESS_UNAVAILABLE: 'Caddi has no stable connection address yet. Try again in a moment.',
  AGENT_TOOL_CONFIG_INVALID: 'That tool\u2019s settings file could not be read safely, so Caddi left it alone. Use Copy configuration instead.',
  AGENT_TOOL_CONFIG_UNREADABLE: 'That tool\u2019s settings file could not be read. Use Copy configuration instead.',
  AGENT_TOOL_CONFIG_UNWRITABLE: 'That tool\u2019s settings file could not be updated. Use Copy configuration instead.',
  AGENT_TOOL_COMMAND_FAILED: 'The tool did not accept the change. Use Copy configuration instead.',
  AGENT_TOOL_NOT_INSTALLED: 'That tool is no longer installed on this Mac.',
  AGENT_TOOL_BUSY: 'Another tool is being set up. Try again in a moment.',
};
export const agentToolMessage = code => toolMessages[code] ?? 'That tool could not be changed. Use Copy configuration instead.';

/** Installed tools only, connected ones first. One-click setup needs the stable
 * address, so it is not offered while only a temporary address exists. */
export function agentToolsView(snapshot) {
  const stable = snapshot?.connectionSetup?.mode === 'stable' && snapshot.connectionSetup.status === 'ready';
  const tools = snapshot?.privateBrowsing || !Array.isArray(snapshot?.agentTools) ? [] :
    snapshot.agentTools.filter(tool => tool?.installed === true && typeof tool.id === 'string' && typeof tool.name === 'string');
  // A stale set-up points at a copy of Caddi that is gone (moved, or run from its disk image) or was made by an
  // earlier version; connecting again repairs it.
  return { visible: tools.length > 0, stable, tools: tools.map(tool => { const stale = tool.connected === true && tool.stale === true; return { id: tool.id, name: tool.name, connected: tool.connected === true, stale,
    status: stale ? 'Set up by an earlier version of Caddi, or for a copy that is no longer there. Reconnect to fix it.' : tool.connected ? 'Connected. It asks here the first time it uses Caddi.' : stable ? 'Ready to connect' : 'Waiting for a stable connection address',
    action: stale ? 'Reconnect' : tool.connected ? 'Remove' : 'Connect', disabled: (stale || !tool.connected) && !stable }; }) };
}

export function renderAgentTools(snapshot, ownerDocument = document, { panelId = 'agent-tools-panel', listId = 'agent-tools' } = {}) {
  const view = agentToolsView(snapshot), panel = ownerDocument.getElementById(panelId), list = ownerDocument.getElementById(listId);
  panel.hidden = !view.visible;
  const signature = JSON.stringify(view.tools);
  if (list.dataset.signature === signature) return view;
  list.dataset.signature = signature;
  list.replaceChildren(...view.tools.map(tool => {
    const item = ownerDocument.createElement('li'), text = ownerDocument.createElement('div'), name = ownerDocument.createElement('strong'),
      status = ownerDocument.createElement('span'), button = ownerDocument.createElement('button');
    item.className = 'agent-tool'; item.dataset.connected = String(tool.connected);
    name.textContent = tool.name; status.textContent = tool.status; text.append(name, status);
    button.type = 'button'; button.textContent = tool.action; button.disabled = tool.disabled;
    button.className = tool.connected && !tool.stale ? 'subtle' : 'primary';
    button.dataset.agentTool = tool.id; button.dataset.agentToolAction = tool.connected && !tool.stale ? 'disconnect' : 'connect';
    button.setAttribute('aria-label', tool.action + ' ' + tool.name);
    item.append(text, button);
    return item;
  }));
  return view;
}
