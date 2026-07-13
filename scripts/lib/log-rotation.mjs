import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

function keepTail(path, maxBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r+');
    const size = fstatSync(descriptor).size;
    if (size <= maxBytes) return;
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, size - maxBytes);
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, buffer, 0, bytesRead, 0);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Rotate a file before it grows without bound, retaining newest backups first. */
export function rotateFile(path, { maxBytes, maxBackups = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('log rotation maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxBackups) || maxBackups < 1) {
    throw new Error('log rotation maxBackups must be a positive safe integer');
  }
  // Older versions could already have left an oversized backup behind. Bound
  // those tails on every refresh even when today's active log is still small.
  for (let index = 1; index <= maxBackups; index += 1) {
    const backup = `${path}.${index}`;
    if (existsSync(backup)) keepTail(backup, maxBytes);
  }
  if (!existsSync(path) || statSync(path).size <= maxBytes) return false;

  const oldest = `${path}.${maxBackups}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = maxBackups - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
  for (let index = 1; index <= maxBackups; index += 1) {
    const backup = `${path}.${index}`;
    if (existsSync(backup)) keepTail(backup, maxBytes);
  }
  return true;
}
