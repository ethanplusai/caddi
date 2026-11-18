import fs from 'node:fs';
import path from 'node:path';
import { CaddiError, assertInteger, cloneData } from '../contracts.mjs';
import { sealRecord, unsealRecord } from './crypto.mjs';
import { digest, FEEDBACK_LIMITS } from './model.mjs';
import { privateDirectory, assertDirectory, atomicWrite, readPrivateFile, removePrivateFile, syncDirectory, cleanTemporaryFiles } from './files.mjs';

const transactionName = sequence => String(sequence).padStart(16, '0') + '.enc';
const transactionPattern = /^([0-9]{16})\.enc$/;
const corrupt = () => { throw new CaddiError('STORE_CORRUPT', 'Encrypted transaction history is invalid'); };

// One encrypted event is one atomic commit, including any artifact bytes and
// outbox/inbox changes. No plaintext journal, staging file or sidecar is written.
export class EncryptedJournal {
  constructor({ directory, workspaceId, key, initialState, reducer, validateState, fault = () => {} }) {
    this.anchor = privateDirectory(directory, { create: true });
    this.workspaceId = workspaceId;
    this.key = key;
    this.reducer = reducer;
    this.validateState = validateState;
    this.fault = fault;
    this.sequence = 0;
    this.tipDigest = null;
    this.state = initialState();
    this.poisoned = false;
    this.bytes = 0;
    cleanTemporaryFiles(this.anchor);
    const checkpoint = path.join(this.anchor.path, 'checkpoint.enc');
    if (fs.existsSync(checkpoint)) {
      const bytes = readPrivateFile(checkpoint);
      const saved = unsealRecord(key, workspaceId, 'checkpoint', bytes);
      this.#validateCheckpoint(saved);
      this.sequence = saved.sequence;
      this.tipDigest = saved.tipDigest;
      this.state = saved.state;
      this.bytes += bytes.length;
    }
    const names = fs.readdirSync(this.anchor.path);
    for (const name of names) {
      if (!transactionPattern.test(name) && name !== 'checkpoint.enc') corrupt();
    }
    for (const name of names.filter(name => transactionPattern.test(name)).sort()) {
      const sequence = Number(transactionPattern.exec(name)[1]);
      const bytes = readPrivateFile(path.join(this.anchor.path, name));
      this.bytes += bytes.length;
      // Authenticate even pre-checkpoint leftovers. A damaged complete record
      // is never mistaken for a harmless partially written tail.
      const record = unsealRecord(key, workspaceId, 'transaction/' + sequence, bytes);
      if (record.schemaVersion !== 1 || record.workspaceId !== workspaceId || record.sequence !== sequence) corrupt();
      if (sequence <= this.sequence) continue;
      if (sequence !== this.sequence + 1 || record.previousDigest !== this.tipDigest) corrupt();
      this.state = this.reducer(this.state, record.event);
      this.sequence = sequence;
      this.tipDigest = digest(bytes);
    }
    this.validateState(this.state);
    if (this.bytes > FEEDBACK_LIMITS.journalBytes) throw new CaddiError('STORE_LIMIT_EXCEEDED', 'Journal needs explicit retention or compaction');
  }
  #validateCheckpoint(saved) {
    if (!saved || saved.schemaVersion !== 1 || saved.workspaceId !== this.workspaceId) corrupt();
    assertInteger(saved.sequence, 'sequence');
    if (saved.tipDigest !== null && !/^[a-f0-9]{64}$/.test(saved.tipDigest)) corrupt();
    if ((saved.sequence === 0) !== (saved.tipDigest === null)) corrupt();
    this.validateState(saved.state);
  }
  assertUsable() {
    if (this.poisoned) throw new CaddiError('STORE_RECOVERY_REQUIRED', 'Commit outcome is unknown; reopen the workspace');
    assertDirectory(this.anchor);
  }
  append(event, check) {
    this.assertUsable();
    check();
    const detachedEvent = cloneData(event, { maxBytes: FEEDBACK_LIMITS.stateBytes });
    const nextState = this.reducer(this.state, detachedEvent);
    this.validateState(nextState);
    const sequence = this.sequence + 1;
    const bytes = sealRecord(this.key, this.workspaceId, 'transaction/' + sequence, {
      schemaVersion: 1, workspaceId: this.workspaceId, sequence, previousDigest: this.tipDigest, event: detachedEvent,
    });
    if (this.bytes + bytes.length > FEEDBACK_LIMITS.journalBytes) throw new CaddiError('STORE_LIMIT_EXCEEDED', 'Journal needs explicit retention or compaction');
    try {
      atomicWrite(this.anchor, transactionName(sequence), bytes, { check, fault: this.fault });
    } catch (error) {
      if (error.commitOutcomeUnknown) this.poisoned = true;
      throw error;
    }
    this.state = nextState;
    this.sequence = sequence;
    this.tipDigest = digest(bytes);
    this.bytes += bytes.length;
  }
  compact(check) {
    this.assertUsable(); check();
    const checkpoint = { schemaVersion: 1, workspaceId: this.workspaceId, sequence: this.sequence, tipDigest: this.tipDigest, state: this.state };
    const bytes = sealRecord(this.key, this.workspaceId, 'checkpoint', checkpoint);
    try { atomicWrite(this.anchor, 'checkpoint.enc', bytes, { replace: true, check, fault: this.fault }); }
    catch (error) { if (error.commitOutcomeUnknown) this.poisoned = true; throw error; }
    for (const name of fs.readdirSync(this.anchor.path)) {
      const match = transactionPattern.exec(name);
      if (match && Number(match[1]) <= this.sequence) removePrivateFile(this.anchor, name);
    }
    syncDirectory(this.anchor.path);
    this.bytes = bytes.length;
  }
  exportBackup(check, now) {
    this.assertUsable(); check();
    const bytes = sealRecord(this.key, this.workspaceId, 'backup', {
      schemaVersion: 1, workspaceId: this.workspaceId, createdAt: now, state: this.state,
    });
    check();
    return bytes;
  }
  restoreBackup(bytes, check) {
    this.assertUsable(); check();
    if (this.sequence !== 0 || Object.keys(this.state.revisions).length || Object.keys(this.state.deliveries).length ||
        Object.keys(this.state.tombstones).length || Object.keys(this.state.revisionHeads).length) {
      throw new CaddiError('RESTORE_REQUIRES_EMPTY_STORE', 'Restore requires an empty workspace store');
    }
    const backup = unsealRecord(this.key, this.workspaceId, 'backup', bytes);
    if (backup.schemaVersion !== 1 || backup.workspaceId !== this.workspaceId || !Number.isSafeInteger(backup.createdAt)) corrupt();
    this.validateState(backup.state);
    for (const delivery of Object.values(backup.state.deliveries)) {
      if (!['host-applied', 'cancelled'].includes(delivery.status)) delivery.restoreQuarantined = true;
    }
    const saved = { schemaVersion: 1, workspaceId: this.workspaceId, sequence: 0, tipDigest: null, state: backup.state };
    const encrypted = sealRecord(this.key, this.workspaceId, 'checkpoint', saved);
    try { atomicWrite(this.anchor, 'checkpoint.enc', encrypted, { replace: true, check, fault: this.fault }); }
    catch (error) { if (error.commitOutcomeUnknown) this.poisoned = true; throw error; }
    this.state = backup.state;
    this.bytes = encrypted.length;
  }
  discardPlaintext() {
    this.state = null;
    this.key = null;
    this.poisoned = true;
  }
}
