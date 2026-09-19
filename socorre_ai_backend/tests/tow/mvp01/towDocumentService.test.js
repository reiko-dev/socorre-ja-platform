/**
 * MVP-01 — UNIT suite for the TowVehicle document application service.
 *
 * Covers the Muse correction findings:
 *   - MMVP-2: `expires_at` is validated before persistence (garbage -> 422) and
 *     a past value is stored but makes the document effectively expired;
 *   - MMVP-5: deleting a document also removes its stored bytes, best-effort,
 *     without touching the bytes of other documents.
 *
 * Pure ports only: no database, no filesystem.
 */
'use strict';

const { createDocumentService } = require('../../../src/modules/tow/application/document-service');
const { TowError } = require('../../../src/modules/tow/domain');

function file(overrides = {}) {
  return {
    buffer: Buffer.from('fake-bytes'),
    originalname: 'crlv.jpg',
    mimetype: 'image/jpeg',
    size: 10,
    ...overrides,
  };
}

function buildService({ documents = [] } = {}) {
  const state = { inserted: null, removedId: null };
  const documentRepository = {
    findById: async (id) => documents.find((document) => String(document.id) === String(id)) || null,
    listByVehicle: async () => documents,
    insert: async (record) => {
      state.inserted = { id: 99, ...record };
      return state.inserted;
    },
    remove: async (id) => {
      state.removedId = id;
      return 1;
    },
  };
  const vehicleRepository = {
    findByPartnerAndId: async (partnerId, vehicleId) => ({ id: vehicleId, partner_id: partnerId }),
  };
  const storage = {
    save: jest.fn(async () => ({ key: 'tow-vehicles/1/stored.jpg' })),
    read: jest.fn(async () => Buffer.from('stored-bytes')),
    remove: jest.fn(async () => {}),
  };
  const clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
  const service = createDocumentService({ documentRepository, vehicleRepository, storage, clock });
  return { service, storage, state };
}

describe('MVP-01 UNIT — document service expires_at handling', () => {
  const base = { partnerId: 1, vehicleId: 1, documentType: 'vehicle_license' };

  test('absent/empty expires_at is stored as null (no expiry)', async () => {
    for (const expiresAt of [undefined, null, '']) {
      const { service, state } = buildService();
      await service.upload({ ...base, file: file(), expiresAt });
      expect(state.inserted.expires_at).toBeNull();
    }
  });

  test('a garbage expires_at is rejected as validation_error before storage', async () => {
    const { service, storage } = buildService();
    const rejection = await service.upload({ ...base, file: file(), expiresAt: 'garbage' }).catch((error) => error);
    expect(rejection).toBeInstanceOf(TowError);
    expect(rejection).toMatchObject({ code: 'validation_error', httpStatus: 422 });
    expect(storage.save).not.toHaveBeenCalled();
  });

  test('non-string junk (boolean/object) is rejected as validation_error', async () => {
    for (const expiresAt of [true, { when: 'tomorrow' }, []]) {
      const { service } = buildService();
      await expect(service.upload({ ...base, file: file(), expiresAt })).rejects.toMatchObject({
        code: 'validation_error',
      });
    }
  });

  test('a past expires_at is accepted at storage time (effective expiry is policy)', async () => {
    const { service, state } = buildService();
    await service.upload({ ...base, file: file(), expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(state.inserted.expires_at).toBeInstanceOf(Date);
    expect(state.inserted.expires_at.getTime()).toBeLessThan(Date.parse('2026-06-01T00:00:00.000Z'));
  });

  test('a valid future expires_at is accepted and stored', async () => {
    const { service, state } = buildService();
    await service.upload({ ...base, file: file(), expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(state.inserted.expires_at).toBeInstanceOf(Date);
    expect(state.inserted.expires_at.getTime()).toBeGreaterThan(Date.parse('2026-06-01T00:00:00.000Z'));
  });
});

describe('MVP-01 UNIT — document removal cleans up stored bytes', () => {
  test('remove deletes the row and asks storage to remove that document file', async () => {
    const documents = [{ id: 5, tow_vehicle_id: 1, file_path: 'tow-vehicles/1/doc-five.jpg' }];
    const { service, storage, state } = buildService({ documents });

    const result = await service.remove({ partnerId: 1, vehicleId: 1, documentId: 5 });

    expect(result).toEqual({ id: 5, deleted: true });
    expect(state.removedId).toBe(5);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('tow-vehicles/1/doc-five.jpg');
  });

  test('remove does not touch the bytes of other documents', async () => {
    const documents = [
      { id: 5, tow_vehicle_id: 1, file_path: 'tow-vehicles/1/doc-five.jpg' },
      { id: 6, tow_vehicle_id: 1, file_path: 'tow-vehicles/1/doc-six.jpg' },
    ];
    const { service, storage } = buildService({ documents });

    await service.remove({ partnerId: 1, vehicleId: 1, documentId: 5 });

    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).not.toHaveBeenCalledWith('tow-vehicles/1/doc-six.jpg');
  });

  test('a storage cleanup failure does not fail the delete (best-effort)', async () => {
    const documents = [{ id: 5, tow_vehicle_id: 1, file_path: 'tow-vehicles/1/doc-five.jpg' }];
    const { service, storage, state } = buildService({ documents });
    storage.remove.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(service.remove({ partnerId: 1, vehicleId: 1, documentId: 5 }))
      .resolves.toEqual({ id: 5, deleted: true });
    expect(state.removedId).toBe(5);
  });
});

describe('MVP-01 EXT UNIT — authenticated document read through the storage port', () => {
  const documents = [{
    id: 5,
    tow_vehicle_id: 1,
    file_path: 'tow-vehicles/1/doc-five.jpg',
    mime_type: 'image/jpeg',
    original_name: 'crlv.jpg',
  }];

  test('admin read returns bytes, mime and original filename from the port', async () => {
    const { service, storage } = buildService({ documents });
    const result = await service.readForAdmin({ documentId: 5 });

    expect(result.buffer.equals(Buffer.from('stored-bytes'))).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('crlv.jpg');
    expect(storage.read).toHaveBeenCalledWith('tow-vehicles/1/doc-five.jpg');
  });

  test('partner read enforces vehicle ownership and document/vehicle match', async () => {
    const { service } = buildService({ documents });

    await expect(service.readForVehicle({ partnerId: 1, vehicleId: 1, documentId: 5 }))
      .resolves.toMatchObject({ mimeType: 'image/jpeg' });

    const mismatch = await service.readForVehicle({ partnerId: 1, vehicleId: 2, documentId: 5 })
      .catch((error) => error);
    expect(mismatch).toMatchObject({ code: 'not_found' });
  });

  test('a missing storage object is reported as not_found', async () => {
    const { service, storage } = buildService({ documents });
    const enoent = new Error('missing');
    enoent.code = 'ENOENT';
    storage.read.mockRejectedValueOnce(enoent);

    await expect(service.readForAdmin({ documentId: 5 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
