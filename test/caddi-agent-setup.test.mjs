import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { agentSetupView, renderAgentSetup } from '../src/caddi/desktop/ui/agent-setup.mjs';

const html=await fs.readFile(new URL('../src/caddi/desktop/ui/index.html',import.meta.url),'utf8');
const config=(flag,address)=>({mcpServers:{caddi:{command:'node',args:['/synthetic/scripts/caddi-desktop-client.mjs',flag,address,'--name','Coding agent']}}});
const stable=()=>({privateBrowsing:null,connectionSetup:{mode:'stable',status:'ready',code:null,requiresApproval:true,persistentAuthentication:false},
  connectionConfig:config('--rendezvous','/synthetic/protected/current-agent.json')});
const temporary=(status='not-configured')=>({privateBrowsing:null,connectionSetup:{mode:'temporary',status,code:status==='unavailable'?'RENDEZVOUS_REPLACED':null,
  requiresApproval:true,persistentAuthentication:false},connectionConfig:config('--socket','/synthetic/temporary/enrollment.sock')});
function documentFixture(){
  class Element{constructor(){this.value='';this.writes=0;this.dataset={};this.disabled=false;this.hidden=false;}
    get textContent(){return this.value;}set textContent(value){this.value=value;this.writes++;}}
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  return{elements,document:{getElementById:id=>elements.get(id)}};
}

test('stable setup displays the exact main-generated rendezvous configuration while requiring fresh approval and scope',()=>{
  const state=stable(),before=structuredClone(state),view=agentSetupView(state);
  assert.equal(view.mode,'stable');assert.equal(view.available,true);assert.equal(view.configText,JSON.stringify(state.connectionConfig,null,2));
  assert.match(view.description,/Reuse it after ordinary Caddi restarts/);
  assert.match(view.approval,/Compare the code/);assert.match(view.approval,/approve again/);assert.match(view.approval,/workspace and site access/);
  assert.doesNotMatch(view.status+view.description+view.approval,/\/synthetic|current-agent\.json|saved authentication|automatically approve/i);
  assert.deepEqual(state,before);
});

test('failed stable publication retains only the actual temporary configuration and never exposes its raw diagnostic',()=>{
  const state=temporary('unavailable'),view=agentSetupView(state);
  assert.equal(view.mode,'temporary');assert.equal(view.available,true);assert.equal(view.status,'Stable connection address unavailable');
  assert.match(view.description,/temporary configuration/);assert.match(view.description,/after restarting/);
  assert.equal(view.configText,JSON.stringify(state.connectionConfig,null,2));assert.ok(view.configText.includes('--socket'));
  assert.doesNotMatch(view.status+view.description+view.approval,/RENDEZVOUS_REPLACED|\/synthetic|enrollment\.sock/);
});

test('ordinary temporary setup and older socket snapshots never promise stable discovery or persistent authentication',()=>{
  const state=temporary(),view=agentSetupView(state);assert.equal(view.status,'Temporary connection address');
  assert.match(view.description,/Copy a new configuration after each Caddi restart/);assert.match(view.approval,/approve again/);
  delete state.connectionSetup;assert.equal(agentSetupView(state).mode,'temporary');
});

test('an unavailable rendezvous has no invented socket fallback and a private window exposes no normal setup',()=>{
  const state=stable();state.connectionSetup.status='unavailable';
  let view=agentSetupView(state);assert.equal(view.available,false);assert.equal(view.configText,'');
  state.connectionSetup.status='ready';state.connectionSetup.persistentAuthentication=true;
  view=agentSetupView(state);assert.equal(view.available,false);
  state.privateBrowsing={scopeId:'PRIVATE_SCOPE'};view=agentSetupView(state);assert.equal(view.available,false);assert.equal(view.configText,'');
  assert.match(view.description,/private window/);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_SCOPE|\/synthetic/);
  assert.equal(agentSetupView({connectionConfig:null}).available,false);
});

test('status rendering clears a stale configuration, disables Copy, and announces only changed status text',()=>{
  const f=documentFixture(),state=stable();renderAgentSetup(state,f.document);
  assert.equal(f.elements.get('copy-config').disabled,false);assert.equal(f.elements.get('mcp-config').textContent,JSON.stringify(state.connectionConfig,null,2));
  const writes=f.elements.get('agent-setup-status').writes;renderAgentSetup(structuredClone(state),f.document);
  assert.equal(f.elements.get('agent-setup-status').writes,writes);
  renderAgentSetup(temporary('unavailable'),f.document);
  assert.equal(f.elements.get('agent-setup-status').writes,writes+1);assert.equal(f.elements.get('copy-config').disabled,false);
  assert.equal(f.elements.get('mcp-config').textContent,JSON.stringify(temporary('unavailable').connectionConfig,null,2));
  renderAgentSetup({...state,privateBrowsing:{scopeId:'private'}},f.document);
  assert.equal(f.elements.get('mcp-config').textContent,'');assert.equal(f.elements.get('mcp-config').hidden,true);
  assert.equal(f.elements.get('copy-config').disabled,true);assert.equal(f.elements.get('agent-setup-approval').hidden,true);
});
