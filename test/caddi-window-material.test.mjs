import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachWindowMaterial } from '../src/caddi/desktop/window-material.mjs';
function fixture() {
  const theme = Object.assign(new EventEmitter(), { prefersReducedTransparency:false, shouldUseHighContrastColors:false, shouldUseDarkColors:false });
  const calls = [];
  const window = Object.assign(new EventEmitter(), { isDestroyed:()=>false, setVibrancy:value=>calls.push(['vibrancy',value]), setBackgroundColor:value=>calls.push(['background',value]) });
  return {theme,window,calls};
}
test('native material follows accessibility changes and detaches when its own window closes',()=>{
  const {theme,window,calls}=fixture(); attachWindowMaterial(window,theme,'darwin');
  assert.deepEqual(calls.slice(-2),[['vibrancy','sidebar'],['background','#00000000']]);
  theme.prefersReducedTransparency=true; theme.emit('updated');
  assert.deepEqual(calls.slice(-2),[['vibrancy',null],['background','#f1f1f1']]);
  theme.shouldUseDarkColors=true; theme.emit('updated');
  assert.equal(calls.at(-1)[1],'#252525');
  theme.prefersReducedTransparency=false; theme.shouldUseHighContrastColors=true; theme.emit('updated');
  assert.equal(calls.at(-2)[1],null);
  theme.shouldUseHighContrastColors=false; theme.emit('updated');
  assert.equal(calls.at(-2)[1],'sidebar');
  window.emit('closed'); const count=calls.length; theme.emit('updated');
  assert.equal(calls.length,count); assert.equal(theme.listenerCount('updated'),0);
});
test('non-macOS windows do not call unsupported material APIs',()=>{
  const {theme,window,calls}=fixture(); attachWindowMaterial(window,theme,'linux'); theme.emit('updated');
  assert.equal(calls.length,0); assert.equal(theme.listenerCount('updated'),0);
});
