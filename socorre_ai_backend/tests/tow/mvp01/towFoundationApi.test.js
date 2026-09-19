/**
 * MVP-01 — API suite: real Express app + auth middleware + thin controllers
 * over the SQLite harness schema.
 *
 * Covers #13 HTTP behavior:
 *   - public module status and admin-only module toggle (idempotent);
 *   - TowVehicle CRUD + activate transferring the single active slot;
 *   - vehicle document upload/approval driving operational eligibility;
 *   - typed Tow settings get/patch.
 *
 * RED-first: written before the MVP-01 tables, routes and services exist.
 */
'use strict';

process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

jest.mock('../../../src/config/database', () => require('../../helpers/testDb').db);

const request = require('supertest');
const jwt = require('jsonwebtoken');
const testDb = require('../../helpers/testDb');
const { createApp } = require('../../../src/app');

function tokenFor(user) {
  return jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createPartnerFixture(name) {
  const user = await testDb.createUser({ name, role: 'partner', email: `${name}@mvp01.test` });
  const partner = await testDb.createPartner({ user_id: user.id, type: 'tow', business_name: name, approval_status: 'approved' });
  return { user, partner, token: tokenFor(user), headers: { Authorization: `Bearer ${tokenFor(user)}` } };
}

const validVehicle = (plate = 'ABC1D23') => ({
  plate,
  make: 'Ford',
  model: 'F-4000',
  year: 2020,
  equipment_type: 'flatbed',
  supported_vehicle_classes: ['light_vehicle'],
  max_towed_weight_kg: 4000,
  pricing: { minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 },
});

describe('MVP-01 API — Tow foundation', () => {
  let app;
  let admin;
  let alpha;
  let beta;

  beforeAll(async () => {
    await testDb.reset();
    app = createApp();
    admin = await testDb.createUser({ name: 'Admin MVP01', role: 'admin', email: 'admin.mvp01@mvp01.test' });
    alpha = await createPartnerFixture('alpha');
    beta = await createPartnerFixture('beta');
  });

  afterAll(async () => {
    await testDb.reset();
  });

  describe('module status and toggle', () => {
    test('module-status is public and starts enabled', async () => {
      const response = await request(app).get('/api/tow/module-status');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({ module_key: 'tow', service_key: 'tow', enabled: true });
    });

    test('a non-admin cannot toggle or read the admin module view', async () => {
      const toggle = await request(app)
        .patch('/api/admin/tow/module')
        .set(alpha.headers)
        .send({ enabled: false, reason: 'nope' });
      expect(toggle.status).toBe(403);
      expect(toggle.body.error.code).toBe('forbidden');

      const read = await request(app).get('/api/admin/tow/module').set(alpha.headers);
      expect(read.status).toBe(403);
    });

    test('admin toggle disables new business and is idempotent', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const disabled = await request(app)
        .patch('/api/admin/tow/module')
        .set(adminHeaders)
        .send({ enabled: false, reason: 'maintenance window' });
      expect(disabled.status).toBe(200);
      expect(disabled.body.data.enabled).toBe(false);
      expect(disabled.body.data.disabled_reason).toBe('maintenance window');

      const again = await request(app)
        .patch('/api/admin/tow/module')
        .set(adminHeaders)
        .send({ enabled: false, reason: 'maintenance window' });
      expect(again.status).toBe(200);
      expect(again.body.data.enabled).toBe(false);

      const status = await request(app).get('/api/tow/module-status');
      expect(status.body.data.enabled).toBe(false);

      // Restore for the rest of the suite.
      const enabled = await request(app)
        .patch('/api/admin/tow/module')
        .set(adminHeaders)
        .send({ enabled: true, reason: 'back online' });
      expect(enabled.body.data.enabled).toBe(true);
      expect(enabled.body.data.disabled_reason).toBeNull();
    });

    test('an invalid toggle body is rejected as validation_error', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const response = await request(app)
        .patch('/api/admin/tow/module')
        .set(adminHeaders)
        .send({ enabled: 'yes' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_error');
    });
  });

  describe('TowVehicle lifecycle', () => {
    test('creates, lists, updates and activates a vehicle', async () => {
      const created = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle());
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ active: false, plate: 'ABC1D23' });
      expect(created.body.data.pricing.minimum_charge_cents).toBe(15000);
      const vehicleId = created.body.data.id;

      const listed = await request(app).get('/api/tow/vehicles').set(alpha.headers);
      expect(listed.status).toBe(200);
      expect(listed.body.data.items).toHaveLength(1);

      const updated = await request(app)
        .patch(`/api/tow/vehicles/${vehicleId}`)
        .set(alpha.headers)
        .send({ make: 'Scania' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.make).toBe('Scania');

      const activated = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/activate`)
        .set(alpha.headers)
        .send({});
      expect(activated.status).toBe(200);
      expect(activated.body.data.active).toBe(true);

      const status = await request(app).get(`/api/tow/vehicles/${vehicleId}`).set(alpha.headers);
      expect(status.body.data.active).toBe(true);
      expect(status.body.data.document_status).toBe('pending');
    });

    test('activating a second vehicle transfers the single active slot', async () => {
      const second = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('XYZ9Z99'));
      expect(second.status).toBe(201);
      const secondId = second.body.data.id;

      const activated = await request(app)
        .post(`/api/tow/vehicles/${secondId}/activate`)
        .set(alpha.headers)
        .send({});
      expect(activated.status).toBe(200);
      expect(activated.body.data.active).toBe(true);

      const listed = await request(app).get('/api/tow/vehicles').set(alpha.headers);
      const active = listed.body.data.items.filter((item) => item.active === true);
      expect(active).toHaveLength(1);
      expect(String(active[0].id)).toBe(String(secondId));
    });

    test('invalid vehicle input is a validation_error', async () => {
      const response = await request(app)
        .post('/api/tow/vehicles')
        .set(alpha.headers)
        .send({ ...validVehicle('BAD1BAD'), supported_vehicle_classes: [] });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_error');
    });

    test('another partner vehicle is isolated (not_found)', async () => {
      const created = await request(app).post('/api/tow/vehicles').set(beta.headers).send(validVehicle('BETA123'));
      const foreignId = created.body.data.id;
      const response = await request(app).get(`/api/tow/vehicles/${foreignId}`).set(alpha.headers);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    });

    test('creating a vehicle with a duplicate plate for the same partner is a conflict (409)', async () => {
      const first = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('DUP1D23'));
      expect(first.status).toBe(201);

      const duplicate = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('DUP1D23'));
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('conflict');

      const listed = await request(app).get('/api/tow/vehicles').set(alpha.headers);
      const matching = listed.body.data.items.filter((item) => item.plate === 'DUP1D23');
      expect(matching).toHaveLength(1);
    });

    test('patching a plate to an existing plate of the same partner is a conflict and changes nothing', async () => {
      const first = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('PATCHA1'));
      const second = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('PATCHB2'));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const conflict = await request(app)
        .patch(`/api/tow/vehicles/${first.body.data.id}`)
        .set(alpha.headers)
        .send({ plate: 'PATCHB2' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('conflict');

      const unchanged = await request(app).get(`/api/tow/vehicles/${first.body.data.id}`).set(alpha.headers);
      expect(unchanged.body.data.plate).toBe('PATCHA1');
    });
  });

  describe('vehicle documents and operational eligibility', () => {
    test('uploaded documents are pending and do not make the vehicle operational', async () => {
      const created = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('DOC1D23'));
      const vehicleId = created.body.data.id;
      await request(app).post(`/api/tow/vehicles/${vehicleId}/activate`).set(alpha.headers).send({});

      const upload = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/documents`)
        .set(alpha.headers)
        .field('document_type', 'vehicle_license')
        .attach('file', Buffer.from('fake-image-bytes'), { filename: 'crlv.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(201);
      expect(upload.body.data.status).toBe('pending');

      const listed = await request(app).get(`/api/tow/vehicles/${vehicleId}/documents`).set(alpha.headers);
      expect(listed.status).toBe(200);
      expect(listed.body.data.items).toHaveLength(1);
      expect(listed.body.data.items[0].document_type).toBe('vehicle_license');

      const vehicle = await request(app).get(`/api/tow/vehicles/${vehicleId}`).set(alpha.headers);
      expect(vehicle.body.data.document_status).toBe('pending');
    });

    test('admin approval makes the vehicle operational', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const list = await request(app).get('/api/admin/tow/vehicle-documents').set(adminHeaders);
      expect(list.status).toBe(200);
      expect(list.body.data.items.length).toBeGreaterThan(0);
      const documentId = list.body.data.items[0].id;
      const vehicleId = list.body.data.items[0].vehicle_id;

      const approved = await request(app)
        .post(`/api/admin/tow/vehicle-documents/${documentId}/approve`)
        .set(adminHeaders)
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('approved');

      const vehicle = await request(app).get(`/api/tow/vehicles/${vehicleId}`).set(alpha.headers);
      expect(vehicle.body.data.document_status).toBe('approved');
    });

    test('a non-admin cannot list or approve vehicle documents', async () => {
      const response = await request(app).get('/api/admin/tow/vehicle-documents').set(alpha.headers);
      expect(response.status).toBe(403);
    });

    test('reject requires a reason and marks the document rejected', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const created = await request(app).post('/api/tow/vehicles').set(beta.headers).send(validVehicle('REJ1R23'));
      const vehicleId = created.body.data.id;
      const upload = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/documents`)
        .set(beta.headers)
        .field('document_type', 'vehicle_license')
        .attach('file', Buffer.from('bytes'), { filename: 'crlv.png', contentType: 'image/png' });
      const documentId = upload.body.data.id;

      const missingReason = await request(app)
        .post(`/api/admin/tow/vehicle-documents/${documentId}/reject`)
        .set(adminHeaders)
        .send({});
      expect(missingReason.status).toBe(422);

      const rejected = await request(app)
        .post(`/api/admin/tow/vehicle-documents/${documentId}/reject`)
        .set(adminHeaders)
        .send({ reason: 'illegible document' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('rejected');
      expect(rejected.body.data.rejection_reason).toBe('illegible document');
    });

    test('a garbage expires_at is rejected as validation_error before persisting', async () => {
      const created = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('GARB1D23'));
      const vehicleId = created.body.data.id;

      const upload = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/documents`)
        .set(alpha.headers)
        .field('document_type', 'vehicle_license')
        .field('expires_at', 'garbage')
        .attach('file', Buffer.from('bytes'), { filename: 'garbage.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(422);
      expect(upload.body.error.code).toBe('validation_error');

      const listed = await request(app).get(`/api/tow/vehicles/${vehicleId}/documents`).set(alpha.headers);
      expect(listed.body.data.items).toHaveLength(0);
    });

    test('a past expires_at is stored but is not eligible (effectively expired)', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const created = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('PAST1D23'));
      const vehicleId = created.body.data.id;

      const upload = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/documents`)
        .set(alpha.headers)
        .field('document_type', 'vehicle_license')
        .field('expires_at', '2020-01-01T00:00:00.000Z')
        .attach('file', Buffer.from('bytes'), { filename: 'past.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(201);
      const documentId = upload.body.data.id;

      const approved = await request(app)
        .post(`/api/admin/tow/vehicle-documents/${documentId}/approve`)
        .set(adminHeaders)
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('approved');

      const vehicle = await request(app).get(`/api/tow/vehicles/${vehicleId}`).set(alpha.headers);
      expect(vehicle.body.data.document_status).toBe('expired');
    });

    test('a valid future expires_at keeps an approved document eligible', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const created = await request(app).post('/api/tow/vehicles').set(alpha.headers).send(validVehicle('FUTR1D23'));
      const vehicleId = created.body.data.id;

      const upload = await request(app)
        .post(`/api/tow/vehicles/${vehicleId}/documents`)
        .set(alpha.headers)
        .field('document_type', 'vehicle_license')
        .field('expires_at', '2030-01-01T00:00:00.000Z')
        .attach('file', Buffer.from('bytes'), { filename: 'future.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(201);
      const documentId = upload.body.data.id;

      const approved = await request(app)
        .post(`/api/admin/tow/vehicle-documents/${documentId}/approve`)
        .set(adminHeaders)
        .send({});
      expect(approved.status).toBe(200);

      const vehicle = await request(app).get(`/api/tow/vehicles/${vehicleId}`).set(alpha.headers);
      expect(vehicle.body.data.document_status).toBe('approved');
    });
  });

  describe('typed Tow settings', () => {
    test('admin can read the MVP defaults and patch a validated value', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const before = await request(app).get('/api/admin/tow/settings').set(adminHeaders);
      expect(before.status).toBe(200);
      expect(before.body.data.tow_initial_radius_km).toBeGreaterThan(0);

      const patched = await request(app)
        .patch('/api/admin/tow/settings')
        .set(adminHeaders)
        .send({ tow_proposal_expiry_minutes: 25 });
      expect(patched.status).toBe(200);
      expect(patched.body.data.tow_proposal_expiry_minutes).toBe(25);

      const after = await request(app).get('/api/admin/tow/settings').set(adminHeaders);
      expect(after.body.data.tow_proposal_expiry_minutes).toBe(25);
    });

    test('an invalid settings patch is a validation_error', async () => {
      const adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
      const response = await request(app)
        .patch('/api/admin/tow/settings')
        .set(adminHeaders)
        .send({ tow_initial_radius_km: '15' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_error');
    });
  });
});
