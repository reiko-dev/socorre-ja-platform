/**
 * Setup global do Jest.
 *
 * Responsabilidades:
 *  1. definir as variáveis de ambiente ANTES de qualquer módulo de produção ser
 *    carregado (JWT_SECRET, NODE_ENV, Firebase/Redis fictícios);
 *  2. mockar integrações externas que não existem no ambiente de teste
 *    (firebase-admin, redis, socket.io);
 *  3. expor `global.testUtils` com fixtures determinísticas apoiadas no SQLite
 *    em memória de `tests/helpers/testDb.js` (schema real, sem `no such table`).
 *
 * Importante: o JWT de teste é assinado com a claim `userId`, que é exatamente a
 * claim consumida por `src/middleware/auth.js`.
 */
const testDb = require('./helpers/testDb');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
// MVP-01: keep TowVehicle document uploads out of the repository tree during
// tests; the directory lives under the OS temp dir and is removed afterwards.
if (!process.env.TOW_DOCUMENT_STORAGE_DIR) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(os.tmpdir(), `socorre-tow-doc-tests-${process.pid}`);
  process.env.TOW_DOCUMENT_STORAGE_DIR = dir;
  if (typeof afterAll === 'function') {
    afterAll(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        /* best effort */
      }
    });
  }
}
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test-project';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/1';
// Rate limit de produção é 100 req/15min por IP: numa suíte que exercita dezenas
// de endpoints o limite é atingido e os testes passam a receber 429 de forma
// não determinística. Ele continua ativo (mesmo middleware), apenas com um teto
// que não interfere na suíte.
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || '100000';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';

// Mock para Firebase Admin
jest.mock('firebase-admin', () => ({
  credential: {
    cert: jest.fn()
  },
  initializeApp: jest.fn(() => ({
    auth: () => ({
      verifyIdToken: jest.fn(),
      createUser: jest.fn(),
      updateUser: jest.fn(),
      deleteUser: jest.fn()
    }),
    messaging: () => ({
      send: jest.fn(),
      sendMulticast: jest.fn()
    }),
    firestore: () => ({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(),
          set: jest.fn(),
          update: jest.fn(),
          delete: jest.fn()
        })),
        add: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn(),
        get: jest.fn()
      }))
    })
  }))
}));

// Mock para Redis
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    expire: jest.fn(),
    flushAll: jest.fn()
  }))
}));

// Mock para Socket.IO — cobre toda a superfície usada por
// `src/services/socketService.js` (use, on, emit, to, in, sockets) para que uma
// suíte que não exercita transporte real nunca quebre por API ausente
// (`this.io.use is not a function`). O teste de transporte real desativa este
// mock com `jest.mock('socket.io', () => jest.requireActual('socket.io'))`.
jest.mock('socket.io', () => {
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit: jest.fn() }));
  const inRoom = jest.fn(() => ({ emit: jest.fn() }));
  const sockets = {
    emit: jest.fn(),
    to,
    in: inRoom,
    sockets: new Map(),
    adapter: { rooms: new Map() },
    join: jest.fn(),
    leave: jest.fn()
  };

  const Server = jest.fn(function ServerMock() {
    return {
      use: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
      emit,
      to,
      in: inRoom,
      sockets,
      close: jest.fn((callback) => typeof callback === 'function' && callback()),
      engine: { clientsCount: 0 }
    };
  });

  return { Server, io: jest.fn() };
});

// Fixtures apoiadas no SQLite de teste (schema real das migrations).
global.testUtils = {
  db: testDb.db,

  createTestUser: async (overrides = {}) => testDb.createUser(overrides),

  createTestPartner: async (overrides = {}) => testDb.createPartner(overrides),

  createTestSubscription: async (partnerId, overrides = {}) =>
    testDb.createActiveSubscription(partnerId, overrides),

  createTestEmergencyRequest: async (overrides = {}) =>
    testDb.createEmergencyRequest(overrides),

  // Token no MESMO formato consumido por src/middleware/auth.js (claim `userId`).
  generateTestToken: (userId = 1, role = 'user', extraClaims = {}) => {
    const jwt = require('jsonwebtoken');
    return jwt.sign(
      {
        userId,
        email: extraClaims.email || 'test@example.com',
        role,
        ...extraClaims
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  }
};

// Silenciar logs durante os testes (TEST_VERBOSE=1 preserva a saída para debug)
if (process.env.NODE_ENV === 'test' && process.env.TEST_VERBOSE !== '1') {
  console.log = jest.fn();
  console.info = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
}
