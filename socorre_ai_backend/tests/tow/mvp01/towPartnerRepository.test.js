/**
 * MVP-01 EXT — UNIT/integration suite for the `PartnerRepository` port adapter.
 *
 * EXT-MVP01-2 central eligibility must know the partner identity without the
 * domain/application depending on the legacy `Partner` model or Knex. This
 * suite proves the adapter returns only the `{ id, type }` projection and null
 * for a missing partner.
 *
 * RED-first: written before `partner-repository` exists.
 */
'use strict';

jest.mock('../../../src/config/database', () => require('../../helpers/testDb').db);

const testDb = require('../../helpers/testDb');
const { createPartnerRepository } = require('../../../src/modules/tow/adapters/persistence/partner-repository');

describe('MVP-01 EXT — partner repository port adapter', () => {
  let repository;

  beforeAll(async () => {
    await testDb.reset();
    repository = createPartnerRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.reset();
  });

  test('findById returns the minimal id/type projection', async () => {
    const user = await testDb.createUser({ role: 'partner' });
    const partner = await testDb.createPartner({ user_id: user.id, type: 'tow' });

    await expect(repository.findById(partner.id)).resolves.toEqual({ id: partner.id, type: 'tow' });
  });

  test('findById returns null for a missing partner', async () => {
    await expect(repository.findById(999999)).resolves.toBeNull();
  });

  test('requires a knex instance', () => {
    expect(() => createPartnerRepository()).toThrow(TypeError);
  });
});
