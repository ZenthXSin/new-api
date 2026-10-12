import { Readable } from 'node:stream';
import { workspaceError } from './user-layout.mjs';

export const MAX_DOWNLOAD = 1024 * 1024 * 1024;

// Both local Python and SSH use one checked file descriptor: a JSON status
// line followed by raw bytes. Keep backpressure and cancel the process on close.
export async function openFileDownload(child, input, { signal } = {}) {
  const closed = new Promise(resolve => {
    child.once('close', code => resolve(code));
    child.once('error', () => resolve(-1));
  });
  const cancel = () => child.kill('SIGKILL');
  const timer = setTimeout(cancel, 300_000);
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const iterator = child.stdout[Symbol.asyncIterator]();
  try {
    if (signal?.aborted) throw workspaceError('Download canceled', 'download_canceled', 499);
    let prefix = Buffer.alloc(0), remainder;
    while (remainder === undefined) {
      const { value, done } = await iterator.next();
      if (done) throw workspaceError('File download could not start', 'file_operation_failed', 502);
      const newline = value.indexOf(10);
      prefix = Buffer.concat([prefix, newline < 0 ? value : value.subarray(0, newline)]);
      if (prefix.length > 8192) throw workspaceError('Invalid file download response', 'file_operation_failed', 502);
      if (newline >= 0) remainder = value.subarray(newline + 1);
    }
    let metadata;
    try { metadata = JSON.parse(prefix.toString('utf8')); }
    catch { throw workspaceError('Invalid file download response', 'file_operation_failed', 502); }
    if (!metadata.ok) throw workspaceError(metadata.error, metadata.code, metadata.statusCode);
    const size = metadata.result?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD) throw workspaceError('Invalid file download size', 'file_operation_failed', 502);
    const stream = Readable.from((async function* () {
      let total = remainder.length, pending = remainder;
      try {
        // Hold the final chunk until Python has checked the file for changes and
        // exited successfully, so interrupted transfers cannot appear complete.
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) break;
          total += value.length;
          if (total > size) throw workspaceError('File changed; retry download.', 'file_conflict', 409);
          if (pending.length) yield pending;
          pending = value;
        }
        if (total !== size || await closed !== 0 || signal?.aborted) throw workspaceError('File download was interrupted. Please retry.', 'download_interrupted', 502);
        if (pending.length) yield pending;
      } finally { cleanup(); }
    })());
    stream.once('close', cleanup);
    return { size, stream, cancel: cleanup };
  } catch (error) { cleanup(); throw error; }
}
