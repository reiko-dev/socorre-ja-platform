/**
 * MVP-01 EXT — UNIT suite for the private local FileStorage adapter.
 *
 * Proves the storage contract is private-read only (EXT-MVP01-1):
 *   - the default directory lives OUTSIDE the public `uploads/` tree;
 *   - `save` returns only `{ key }` (never a public URL) and `read` returns the
 *     stored bytes;
 *   - there is no `urlFor` public-URL capability on the implementation;
 *   - a key that tries to escape the base directory is refused;
 *   - the private directory is git-ignored.
 *
 * RED-first: written before the private adapter exists.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalFileStorage } = require('../../../src/modules/tow/adapters/storage/local-file-storage');

describe('MVP-01 EXT UNIT — private local file storage', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tow-private-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the default base directory is outside the public uploads tree', () => {
    const previous = process.env.TOW_DOCUMENT_STORAGE_DIR;
    delete process.env.TOW_DOCUMENT_STORAGE_DIR;
    try {
      const storage = createLocalFileStorage();
      const baseDir = path.resolve(storage.baseDir);
      expect(baseDir).toContain(`${path.sep}private${path.sep}tow-documents`);
      expect(baseDir.split(path.sep)).not.toContain('uploads');
    } finally {
      if (previous === undefined) delete process.env.TOW_DOCUMENT_STORAGE_DIR;
      else process.env.TOW_DOCUMENT_STORAGE_DIR = previous;
    }
  });

  test('the env override is honoured', () => {
    const storage = createLocalFileStorage({ baseDir: dir });
    expect(path.resolve(storage.baseDir)).toBe(path.resolve(dir));
  });

  test('save returns only a key; read returns the bytes; remove deletes them', async () => {
    const storage = createLocalFileStorage({ baseDir: dir });
    const saved = await storage.save({
      buffer: Buffer.from('secret-bytes'),
      originalName: 'crlv.jpg',
      mimeType: 'image/jpeg',
    });

    expect(saved).toEqual({ key: expect.any(String) });
    expect(saved).not.toHaveProperty('url');
    expect(typeof storage.urlFor).toBe('undefined');

    const buffer = await storage.read(saved.key);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toBe('secret-bytes');

    await storage.remove(saved.key);
    await expect(storage.read(saved.key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a key that escapes the base directory is refused', async () => {
    const storage = createLocalFileStorage({ baseDir: dir });
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/escapes/);
    await expect(storage.remove('../../etc/passwd')).rejects.toThrow(/escapes/);
  });

  test('the private directory is git-ignored', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/socorre_ai_backend\/private/);
  });
});
