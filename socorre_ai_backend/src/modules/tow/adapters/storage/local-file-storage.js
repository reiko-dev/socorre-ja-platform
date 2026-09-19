/**
 * MVP-01 EXT — local filesystem implementation of the private FileStorage port.
 *
 * Infrastructure adapter: the only MVP-01 layer allowed to touch the
 * filesystem. The application sees only `save/read/remove`.
 *
 * Privacy guarantee (EXT-MVP01-1): the default base directory lives OUTSIDE the
 * public web tree (`<backend>/private/tow-documents`, never `uploads/`). There is
 * deliberately no public URL capability — bytes are only reachable through the
 * authenticated download endpoints, which read them via this port.
 *
 * The `TOW_DOCUMENT_STORAGE_DIR` env override keeps working (tests point it at a
 * temp dir).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaultBaseDir() {
  if (process.env.TOW_DOCUMENT_STORAGE_DIR) return process.env.TOW_DOCUMENT_STORAGE_DIR;
  // storage -> adapters -> tow -> modules -> src -> backend
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'private', 'tow-documents');
}

function safeExtension(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function createLocalFileStorage(options = {}) {
  const baseDir = path.resolve(options.baseDir || defaultBaseDir());

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Resolve a storage key inside `baseDir`, refusing traversal outside it. Keys
   * are generated internally, but a compromised/forged key must never read or
   * delete arbitrary files.
   */
  function resolveKey(key) {
    const normalized = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = path.resolve(baseDir, normalized);
    if (absolute !== baseDir && !absolute.startsWith(`${baseDir}${path.sep}`)) {
      throw new Error('storage key escapes the base directory');
    }
    return absolute;
  }

  async function save({ buffer, originalName, keyPrefix = 'tow-vehicles' }) {
    const relativeDir = String(keyPrefix).replace(/^\/+|\/+$/g, '');
    const filename = `${crypto.randomBytes(10).toString('hex')}${safeExtension(originalName)}`;
    const key = `${relativeDir}/${filename}`;
    const absolute = resolveKey(key);
    ensureDir(path.dirname(absolute));
    await fs.promises.writeFile(absolute, buffer);
    return { key };
  }

  async function read(key) {
    return fs.promises.readFile(resolveKey(key));
  }

  async function remove(key) {
    const absolute = resolveKey(key);
    try {
      await fs.promises.unlink(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return { save, read, remove, baseDir };
}

module.exports = { createLocalFileStorage };
