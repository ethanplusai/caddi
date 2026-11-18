import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';
import { safeDownloadName } from '../downloads/manager.mjs';

export const MAX_PDF_BYTES = 16 * 1024 * 1024;
const fail = code => { throw new CaddiError(code, 'Page printing is unavailable'); };
const PDF_OPTIONS = Object.freeze({ displayHeaderFooter: false, printBackground: false, preferCSSPageSize: false });
const PRINT_OPTIONS = Object.freeze({ silent: false, printBackground: false, copies: 1 });

export function safePdfName(title) {
  const base = safeDownloadName(title).replace(/\.pdf$/iu, '').slice(0, 100).replace(/[. ]+$/u, '');
  return (base && base !== 'download' ? base : 'page') + '.pdf';
}

function safeDestination(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file ||
      !/\.pdf$/iu.test(file) || file.includes('\0')) fail('PDF_PATH_UNAVAILABLE');
  try {
    const parent = path.dirname(file), directory = fs.lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() ||
        (directory.mode & 0o022) || fs.realpathSync(parent) !== parent) fail('PDF_PATH_UNAVAILABLE');
    try { fs.lstatSync(file); fail('PDF_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { parent, identity: { dev: directory.dev, ino: directory.ino } };
  } catch (error) {
    if (error instanceof CaddiError) throw error;
    fail('PDF_PATH_UNAVAILABLE');
  }
}

/** Stage private bytes, then create the selected new file exclusively with no await between the final fence and publish. */
export async function savePdfExclusive({ file, bytes, assertCurrent }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > MAX_PDF_BYTES ||
      !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || typeof assertCurrent !== 'function') fail('PDF_INVALID');
  const { parent, identity } = safeDestination(file);
  const temporary = path.join(parent, '.caddi-pdf-' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    assertCurrent();
    const current = fs.lstatSync(parent);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino ||
        (current.mode & 0o022) || fs.realpathSync(parent) !== parent) fail('PDF_PATH_UNAVAILABLE');
    try { fs.lstatSync(file); fail('PDF_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assertCurrent();
    // Same-directory hard link is an exclusive no-overwrite publish. No event
    // loop turn can interleave the last authority check with the native link.
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code === 'EEXIST') fail('PDF_EXISTS'); throw error; }
    // Publication is committed once the exclusive link succeeds. A failed
    // staging-name cleanup must not report failure for an existing final PDF.
    try { fs.unlinkSync(temporary); } catch {}
    return { saved: true };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

/** Human-only host workflow. Bindings are resolved in trusted main, never from page metadata or an MCP request. */
export function createPagePrintController({ capture, chooseSavePath, registerPdfWork = null,
  onChange = () => {}, printPage = null, renderPdf = null } = {}) {
  if (typeof capture !== 'function' || typeof chooseSavePath !== 'function' || typeof onChange !== 'function') fail('INVALID_ARGUMENT');
  if (registerPdfWork !== null && typeof registerPdfWork !== 'function') fail('INVALID_ARGUMENT');
  const active = new Map();
  let closed = false;
  function status(ownerWindowId) {
    const item = active.get(ownerWindowId);
    return item ? { busy: true, kind: item.kind } : { busy: false, kind: null };
  }
  function invalidate(filter = {}) {
    for (const item of active.values()) if ((!filter.ownerWindowId || item.binding.ownerWindowId === filter.ownerWindowId) &&
      (!filter.workspaceId || item.binding.workspaceId === filter.workspaceId) &&
      (!filter.tabId || item.binding.tabId === filter.tabId)) item.invalidated = true;
    onChange();
  }
  function begin(kind, { ownerWindowId, tabId }) {
    if (closed) fail('PRINT_CLOSED');
    if (active.has(ownerWindowId)) fail('PRINT_BUSY');
    const binding = capture({ ownerWindowId, tabId });
    binding.assertCurrent();
    const item = { kind, binding, invalidated: false, observer: null, done: null, resolveDone: null };
    item.done = new Promise(resolve => { item.resolveDone = resolve; });
    active.set(ownerWindowId, item); onChange();
    const assertCurrent = () => { if (closed || item.invalidated || active.get(ownerWindowId) !== item) fail('PRINT_CONTEXT_CHANGED'); binding.assertCurrent(); };
    return { item, assertCurrent };
  }
  function finish(item) {
    item.observer?.unregister();
    if (active.get(item.binding.ownerWindowId) === item) active.delete(item.binding.ownerWindowId);
    item.resolveDone();
    onChange();
  }
  async function savePdf(raw) {
    const { item, assertCurrent } = begin('pdf', raw);
    let bytes;
    try {
      const choice = await chooseSavePath({ window: item.binding.window, name: safePdfName(item.binding.title) });
      if (choice?.canceled || !choice?.filePath) return { canceled: true };
      assertCurrent();
      // Verify destination before native rendering and again at exclusive commit.
      safeDestination(choice.filePath);
      if (registerPdfWork) item.observer = registerPdfWork(item.binding, async () => {
        item.invalidated = true;
        await item.done;
        return { stopped: true };
      });
      assertCurrent();
      bytes = await (renderPdf ? renderPdf(item.binding.webContents, PDF_OPTIONS) : item.binding.webContents.printToPDF(PDF_OPTIONS));
      assertCurrent();
      return await savePdfExclusive({ file: choice.filePath, bytes, assertCurrent });
    } catch (error) {
      if (error instanceof CaddiError) throw error;
      fail('PDF_FAILED');
    } finally { bytes?.fill(0); finish(item); }
  }
  async function print(raw) {
    const { item, assertCurrent } = begin('print', raw);
    try {
      assertCurrent();
      const result = await new Promise((resolve, reject) => {
        try {
          const callback = (success, reason) => resolve({ success, reason });
          if (printPage) printPage(item.binding.webContents, PRINT_OPTIONS, callback);
          else item.binding.webContents.print(PRINT_OPTIONS, callback);
        } catch (error) { reject(error); }
      });
      assertCurrent();
      if (!result.success) {
        if (result.reason === 'Print job canceled')
          return { canceled: true };
        fail('PRINT_FAILED');
      }
      return { submitted: true };
    } catch (error) {
      if (error instanceof CaddiError) throw error;
      fail('PRINT_FAILED');
    } finally { finish(item); }
  }
  function close() { closed = true; invalidate(); }
  return Object.freeze({ savePdf, print, status, invalidate, close });
}
