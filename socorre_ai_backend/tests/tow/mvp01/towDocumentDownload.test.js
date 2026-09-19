/**
 * MVP-01 EXT — SEC suite: private storage + authenticated document download.
 *
 * EXT-MVP01-1 requires Tow documents to be private and readable only through an
 * authorized API. This suite exercises the real app (auth/role middleware, real
 * local storage adapter on a temp dir) and proves:
 *   - anonymous -> 401; non-admin -> 403; other partner -> 404 (no leak);
 *   - owning partner / admin -> 200 with the exact stored bytes and mime;
 *   - nonexistent document -> 404; Content-Disposition is safe;
 *   - the DTO `file_url` is the relative authenticated download path, never a
 *     public `/uploads/...` or absolute path;
 *   - direct knowledge of the storage key grants no static access.
 *
 * RED-first: written before the private storage/read/download code exists.
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

/** superagent has no parser for image/*; collect the raw bytes. */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function getBytes(url, headers) {
  return request(app)
    .get(url)
    .set(headers)
    .buffer(true)
    .parse(binaryParser);
}

let app;

describe('MVP-01 EXT SEC — private Tow document storage + authenticated download', () => {
  let adminHeaders;
  let alphaHeaders;
  let betaHeaders;
  let alphaVehicleId;
  let betaVehicleId;
  let alphaDocumentId;
  let betaDocumentId;
  const alphaBytes = Buffer.from('alpha-private-document-bytes');
  const betaBytes = Buffer.from('beta-private-document-bytes');

  function upload(headers, vehicleId, bytes, filename = 'crlv.jpg') {
    return request(app)
      .post(`/api/tow/vehicles/${vehicleId}/documents`)
      .set(headers)
      .field('document_type', 'vehicle_license')
      .attach('file', bytes, { filename, contentType: 'image/jpeg' });
  }

  beforeAll(async () => {
    await testDb.reset();
    app = createApp();

    const admin = await testDb.createUser({ role: 'admin', email: 'admin.dl@mvp01.test' });
    const alphaUser = await testDb.createUser({ role: 'partner', email: 'alpha.dl@mvp01.test' });
    await testDb.createPartner({ user_id: alphaUser.id, type: 'tow', business_name: 'Alpha DL' });
    const betaUser = await testDb.createUser({ role: 'partner', email: 'beta.dl@mvp01.test' });
    await testDb.createPartner({ user_id: betaUser.id, type: 'tow', business_name: 'Beta DL' });

    adminHeaders = { Authorization: `Bearer ${tokenFor(admin)}` };
    alphaHeaders = { Authorization: `Bearer ${tokenFor(alphaUser)}` };
    betaHeaders = { Authorization: `Bearer ${tokenFor(betaUser)}` };

    const alphaVehicle = await request(app).post('/api/tow/vehicles').set(alphaHeaders).send(validVehicle('DLA1P23'));
    alphaVehicleId = alphaVehicle.body.data.id;
    const betaVehicle = await request(app).post('/api/tow/vehicles').set(betaHeaders).send(validVehicle('DLB1P23'));
    betaVehicleId = betaVehicle.body.data.id;

    alphaDocumentId = (await upload(alphaHeaders, alphaVehicleId, alphaBytes)).body.data.id;
    betaDocumentId = (await upload(betaHeaders, betaVehicleId, betaBytes)).body.data.id;
  });

  afterAll(async () => {
    await testDb.reset();
  });

  test('anonymous download is 401 on both surfaces', async () => {
    const admin = await request(app).get(`/api/admin/tow/vehicle-documents/${alphaDocumentId}/download`);
    expect(admin.status).toBe(401);

    const partner = await request(app).get(`/api/tow/vehicles/${alphaVehicleId}/documents/${alphaDocumentId}/download`);
    expect(partner.status).toBe(401);
  });

  test('a non-admin cannot use the admin download route', async () => {
    const response = await request(app)
      .get(`/api/admin/tow/vehicle-documents/${alphaDocumentId}/download`)
      .set(alphaHeaders);
    expect(response.status).toBe(403);
  });

  test('another tow partner gets 404 and never the bytes (no existence leak)', async () => {
    const foreignVehicle = await request(app)
      .get(`/api/tow/vehicles/${alphaVehicleId}/documents/${alphaDocumentId}/download`)
      .set(betaHeaders);
    expect(foreignVehicle.status).toBe(404);
    expect(foreignVehicle.body.error.code).toBe('not_found');

    const foreignDocument = await request(app)
      .get(`/api/tow/vehicles/${betaVehicleId}/documents/${alphaDocumentId}/download`)
      .set(betaHeaders);
    expect(foreignDocument.status).toBe(404);
    expect(foreignDocument.body.error.code).toBe('not_found');
  });

  test('the owning partner downloads only their own bytes with the stored mime', async () => {
    const own = await getBytes(
      `/api/tow/vehicles/${alphaVehicleId}/documents/${alphaDocumentId}/download`,
      alphaHeaders,
    );
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toMatch(/image\/jpeg/);
    expect(own.body.equals(alphaBytes)).toBe(true);

    const other = await getBytes(
      `/api/tow/vehicles/${betaVehicleId}/documents/${betaDocumentId}/download`,
      betaHeaders,
    );
    expect(other.status).toBe(200);
    expect(other.body.equals(betaBytes)).toBe(true);
    expect(other.body.equals(alphaBytes)).toBe(false);
  });

  test('admin downloads any document', async () => {
    const response = await getBytes(`/api/admin/tow/vehicle-documents/${alphaDocumentId}/download`, adminHeaders);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/image\/jpeg/);
    expect(response.body.equals(alphaBytes)).toBe(true);
  });

  test('nonexistent document download is 404 on both surfaces', async () => {
    const admin = await request(app).get('/api/admin/tow/vehicle-documents/999999/download').set(adminHeaders);
    expect(admin.status).toBe(404);

    const partner = await request(app)
      .get(`/api/tow/vehicles/${alphaVehicleId}/documents/999999/download`)
      .set(alphaHeaders);
    expect(partner.status).toBe(404);
  });

  test('Content-Disposition is an attachment with a sanitized filename', async () => {
    const hostile = await upload(alphaHeaders, alphaVehicleId, Buffer.from('hostile'), '../../evil name.jpg');
    const documentId = hostile.body.data.id;

    const response = await getBytes(`/api/admin/tow/vehicle-documents/${documentId}/download`, adminHeaders);
    expect(response.status).toBe(200);
    const disposition = response.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toContain('filename=');
    expect(disposition).not.toContain('..');
    expect(disposition).not.toContain('/');
  });

  test('the DTO file_url is the relative authenticated download path, never /uploads', async () => {
    const list = await request(app).get(`/api/tow/vehicles/${alphaVehicleId}/documents`).set(alphaHeaders);
    const partnerUrl = list.body.data.items[0].file_url;
    expect(partnerUrl).toBe(`/api/tow/vehicles/${alphaVehicleId}/documents/${alphaDocumentId}/download`);
    expect(partnerUrl).not.toMatch(/^https?:\/\//);
    expect(partnerUrl).not.toContain('/uploads/');

    const adminList = await request(app).get('/api/admin/tow/vehicle-documents').set(adminHeaders);
    const adminItem = adminList.body.data.items.find((item) => item.id === alphaDocumentId);
    expect(adminItem.file_url).toBe(`/api/admin/tow/vehicle-documents/${alphaDocumentId}/download`);
    expect(adminItem.file_url).not.toContain('/uploads/');
    expect(adminItem.file_url).not.toMatch(/^https?:\/\//);
  });

  test('direct knowledge of the storage key grants no static access', async () => {
    const row = await testDb.db('tow_vehicle_documents').where({ id: alphaDocumentId }).first();
    expect(row.file_path).toBeTruthy();

    const staticAttempt = await request(app).get(`/uploads/${row.file_path}`);
    expect(staticAttempt.status).toBe(404);

    const directAttempt = await request(app).get(`/${row.file_path}`);
    expect(directAttempt.status).toBe(404);
  });
});
