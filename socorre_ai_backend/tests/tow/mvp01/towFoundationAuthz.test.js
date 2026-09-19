/**
 * MVP-01 — AUTHZ suite: admin-only and partner-ownership enforcement over the
 * real auth/role middleware.
 *
 * RED-first: written before the MVP-01 routes exist.
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

const validVehicle = (plate) => ({
  plate,
  make: 'Ford',
  model: 'F-4000',
  year: 2020,
  equipment_type: 'flatbed',
  supported_vehicle_classes: ['light_vehicle'],
  max_towed_weight_kg: 4000,
  pricing: { minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 },
});

describe('MVP-01 AUTHZ — admin-only and ownership', () => {
  let app;
  let adminHeaders;
  let alphaHeaders;
  let customerHeaders;
  let alphaVehicleId;

  beforeAll(async () => {
    await testDb.reset();
    app = createApp();

    const admin = await testDb.createUser({ name: 'Admin Authz', role: 'admin', email: 'admin.authz@mvp01.test' });
    const alphaUser = await testDb.createUser({ name: 'Alpha Authz', role: 'partner', email: 'alpha.authz@mvp01.test' });
    const alphaPartner = await testDb.createPartner({ user_id: alphaUser.id, type: 'tow', business_name: 'Alpha Authz' });
    const customer = await testDb.createUser({ name: 'Customer Authz', role: 'user', email: 'customer.authz@mvp01.test' });

    adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
    alphaHeaders = { Authorization: `Bearer ${tokenFor(alphaUser)}` };
    customerHeaders = { Authorization: `Bearer ${tokenFor(customer)}` };

    const created = await request(app).post('/api/tow/vehicles').set(alphaHeaders).send(validVehicle('AUTH123'));
    alphaVehicleId = created.body.data.id;
    expect(alphaPartner.type).toBe('tow');
  });

  afterAll(async () => {
    await testDb.reset();
  });

  test('unauthenticated access is 401', async () => {
    const module = await request(app).get('/api/admin/tow/module');
    expect(module.status).toBe(401);

    const vehicles = await request(app).get('/api/tow/vehicles');
    expect(vehicles.status).toBe(401);
  });

  test('a customer user is not an admin and cannot toggle the module', async () => {
    const response = await request(app)
      .patch('/api/admin/tow/module')
      .set(customerHeaders)
      .send({ enabled: false, reason: 'not allowed' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  test('a partner cannot approve/reject their own vehicle document', async () => {
    const upload = await request(app)
      .post(`/api/tow/vehicles/${alphaVehicleId}/documents`)
      .set(alphaHeaders)
      .field('document_type', 'vehicle_license')
      .attach('file', Buffer.from('bytes'), { filename: 'crlv.jpg', contentType: 'image/jpeg' });
    const documentId = upload.body.data.id;

    const approve = await request(app)
      .post(`/api/admin/tow/vehicle-documents/${documentId}/approve`)
      .set(alphaHeaders)
      .send({});
    expect(approve.status).toBe(403);

    const reject = await request(app)
      .post(`/api/admin/tow/vehicle-documents/${documentId}/reject`)
      .set(alphaHeaders)
      .send({ reason: 'self approval' });
    expect(reject.status).toBe(403);

    const eligible = await request(app).get('/api/admin/tow/vehicle-documents').set(alphaHeaders);
    expect(eligible.status).toBe(403);
  });

  test('a customer cannot manage TowVehicles', async () => {
    const response = await request(app).post('/api/tow/vehicles').set(customerHeaders).send(validVehicle('CUST123'));
    expect(response.status).toBe(403);
  });

  test('document upload is scoped to the owning partner (not_found)', async () => {
    const otherUser = await testDb.createUser({ name: 'Other Tow', role: 'partner', email: 'other.authz@mvp01.test' });
    await testDb.createPartner({ user_id: otherUser.id, type: 'tow', business_name: 'Other Tow' });
    const otherHeaders = { Authorization: `Bearer ${tokenFor(otherUser)}` };

    const response = await request(app)
      .post(`/api/tow/vehicles/${alphaVehicleId}/documents`)
      .set(otherHeaders)
      .field('document_type', 'vehicle_license')
      .attach('file', Buffer.from('bytes'), { filename: 'crlv.jpg', contentType: 'image/jpeg' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
