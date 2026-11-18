import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
function run(code, timeout = 5000) {
  const prelude = "import sys; sys.dont_write_bytecode=True\nimport importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('speech',Path('scripts/caddi-speech-evaluate.py'))\ns=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)\n";
  const result = spawnSync(python, ['-c', prelude + code], { cwd: project, encoding: 'utf8', timeout, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}
const fixtures = "import tempfile,shutil\nbase=Path('.test-artifacts/caddi-speech');base.mkdir(parents=True,exist_ok=True)\n";
const reject = "def rejected(fn):\n try: fn()\n except (ValueError,FileNotFoundError): return\n raise AssertionError('operation unexpectedly accepted')\n";

test('synthetic scoring counts real word edits and keeps proper-name errors visible', () => {
  run("assert s.word_error('Save the page.', 'save THE page')['wordEdits']==0\nassert s.word_error('save the page', 'save a tab now')['wordEdits']==3\nassert s.word_error('Caddi remembers tabs', 'Orca remembers tabs')['wordEdits']==1\n");
});

test('archive traversal, links, case aliases and oversized members fail before extraction creates files', () => {
  run(fixtures + reject + `
import tarfile,io
with tempfile.TemporaryDirectory(prefix='test-',dir=base) as folder:
 root=Path(folder)
 for case in ['escape','symlink','hardlink','alias','large']:
  archive=root/(case+'.tar.gz')
  with tarfile.open(archive,'w:gz') as tar:
   if case=='escape':
    item=tarfile.TarInfo('../outside');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
   elif case in ['symlink','hardlink']:
    item=tarfile.TarInfo('linked');item.type=tarfile.SYMTYPE if case=='symlink' else tarfile.LNKTYPE;item.linkname='../outside';tar.addfile(item)
   elif case=='alias':
    for name in ['Same','same']:
     item=tarfile.TarInfo(name);item.size=1;tar.addfile(item,io.BytesIO(b'x'))
   else:
    item=tarfile.TarInfo('large');item.size=8;tar.addfile(item,io.BytesIO(b'12345678'))
  s.MAX_EXPANDED=4 if case=='large' else 100
  destination=root/(case+'-output')
  rejected(lambda:s.extract_archive(archive,destination,'tar'))
  assert not destination.exists()
 assert not (root.parent/'outside').exists()
`);
});

test('hash-pinned input corruption, symlinks and oversized bytes are refused', () => {
  run(fixtures + reject + `
import hashlib,os
with tempfile.TemporaryDirectory(prefix='test-',dir=base) as folder:
 root=Path(folder); resource=root/'model';resource.write_bytes(b'pinned')
 pin={'bytes':6,'sha256':hashlib.sha256(b'pinned').hexdigest()}
 s.verify_resource(resource,pin)
 resource.write_bytes(b'edited')
 rejected(lambda:s.verify_resource(resource,pin))
 resource.write_bytes(b'pinned-extra')
 rejected(lambda:s.verify_resource(resource,pin))
 link=root/'link';link.symlink_to(resource)
 rejected(lambda:s.verify_resource(link,pin))
 alias=root/'alias';os.link(resource,alias)
 rejected(lambda:s.verify_resource(alias,{'bytes':12,'sha256':s.digest(resource)}))
`);
});

test('WAV validation rejects wrong channels/rate instead of scoring invalid speech input', () => {
  run(fixtures + reject + `
import wave
with tempfile.TemporaryDirectory(prefix='test-',dir=base) as folder:
 for channels,rate in [(1,16000),(2,16000),(1,44100)]:
  audio=Path(folder)/('%s-%s.wav'%(channels,rate))
  with wave.open(str(audio),'wb') as out:
   out.setnchannels(channels);out.setsampwidth(2);out.setframerate(rate);out.writeframes(b'\\0\\0'*rate*channels)
  if channels==1 and rate==16000: assert s.wav_info(audio)['seconds']==1
  else: rejected(lambda:s.wav_info(audio))
`);
});

test('stage deadlines and successful-parent exit both stop owned descendants', { timeout: 6000 }, () => {
  run(fixtures + reject + `
import os,sys,time
s.RESERVE=1
with tempfile.TemporaryDirectory(prefix='test-',dir=base) as folder:
 root=Path(folder).resolve();records=[]
 rejected(lambda:s.run_stage([sys.executable,'-c','import time; time.sleep(10)'],root,dict(os.environ),root/'deadline.log',0.05,records))
 assert records[-1]['limit']=='timeout'
 sentinel=root/'escaped'
 child="import time;from pathlib import Path;time.sleep(0.4);Path("+repr(str(sentinel))+").write_text('bad')"
 parent="import subprocess,sys;subprocess.Popen([sys.executable,'-c',"+repr(child)+"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
 s.run_stage([sys.executable,'-c',parent],root,dict(os.environ),root/'parent.log',1,records)
 time.sleep(0.5)
 assert not sentinel.exists()
`, 5000);
});

test('permission failures only count as cleanup after conclusive owned-group quiescence', () => {
  run(reject + `
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
proc=SimpleNamespace(pid=12345,poll=lambda:0,wait=lambda **kwargs:0)
for code,out,err,allowed in [(1,'','',True),(0,'Z\\nZ+\\n','',True),(0,'R\\n','',False),(1,'','permission denied',False),(0,'','',False),(1,'R\\n','',False)]:
 result=subprocess.CompletedProcess([],code,out,err)
 with patch.object(s.os,'killpg',side_effect=PermissionError()),patch.object(s.subprocess,'run',return_value=result):
  if allowed:s.stop_group(proc)
  else:rejected(lambda:s.stop_group(proc))
`);
});
