const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { mountLegacyRoutes } = require('./bootstrap/legacyRoutes');
const { getAllowedOrigins, isOriginAllowed } = require('./config/cors');
const { getJwtSecret } = require('./config/jwt');
const db = require('./config/database');

/**
 * Build the Express application (middleware + routes) without opening any
 * listener. server.js calls this before attaching Socket.IO and listening;
 * HTTP transport tests call the same factory so they exercise the real
 * production stack (helmet, CORS, rate limit, routers, error handler)
 * instead of hand-built request/response mocks.
 */
function createApp() {
  const app = express();

  // Nginx sits in front of Express in production: trust the first proxy
  // so req.ip / secure cookies / rate-limit keys see the real client.
  app.set('trust proxy', 1);

  // Fail fast in production without an explicit JWT secret (no weak fallback).
  // Uses the centralized JWT config shared by HTTP and Socket.IO.
  getJwtSecret();

  // Middleware de segurança
  app.use(helmet());

  // Rate limiting (compatible with trust proxy above).
  // Conservative defaults; override via RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX_REQUESTS.
  // /health is skipped so monitoring is never throttled.
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
  const limiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    message: {
      success: false,
      message: 'Muitas requisições. Tente novamente em alguns minutos.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
  });
  app.use(limiter);

  // CORS (shared allowlist also used by Socket.IO)
  const allowedOrigins = getAllowedOrigins();

  app.use(cors({
    origin: function (origin, callback) {
      // Permitir requisições sem origin (como apps móveis, curl, etc.)
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Não permitido por CORS'));
    },
    credentials: true
  }));

  // Logging
  app.use(morgan('combined'));

  // Body parser
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health check: proves HTTP + PostgreSQL are operational.
  // Returns 200 only when both work; 503 when the database is unreachable.
  // Never exposes stack traces, passwords or connection details.
  app.get('/health', async (req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({
        success: true,
        status: 'ok',
        message: 'Socorre AI Backend está funcionando!',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        checks: {
          http: 'ok',
          postgres: 'ok',
        },
      });
    } catch (error) {
      console.error('Health check failed (postgres unreachable):', error.message);
      res.status(503).json({
        success: false,
        status: 'error',
        message: 'Backend indisponível: banco de dados inacessível.',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        checks: {
          http: 'ok',
          postgres: 'unreachable',
        },
      });
    }
  });

  // Rotas específicas para frontend (evitar confusão)
  app.get('/login', (req, res) => {
    res.json({
      success: false,
      message: 'Esta é uma rota do frontend. Use /api/auth/login para autenticação.'
    });
  });

  app.get('/dashboard', (req, res) => {
    res.json({
      success: false,
      message: 'Esta é uma rota do frontend. Use /api/dashboard para dados do dashboard.'
    });
  });

  // API Routes
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/categories', require('./routes/categories'));
  app.use('/api/dashboard', require('./routes/dashboard'));

  // Rotas do sistema de mecânicos
  app.use('/api/mechanics', require('./routes/mechanics'));
  app.use('/api/services', require('./routes/services'));
  app.use('/api/appointments', require('./routes/appointments'));
  app.use('/api/reviews', require('./routes/reviews'));

  // Rotas do sistema completo de socorro
  app.use('/api/partners', require('./routes/partners'));
  app.use('/api/emergency-requests', require('./routes/emergency-requests'));
  app.use('/api/purchase-orders', require('./routes/purchase-orders'));

  // Rotas oficiais do produto
  app.use('/api/subscriptions', require('./routes/subscriptions'));
  app.use('/api/tow-proposals', require('./routes/towProposals'));
  app.use('/api/delivery-orders', require('./routes/deliveryOrders'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/system-settings', require('./routes/systemSettings'));
  app.use('/api/upload', require('./routes/upload'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/wallets', require('./routes/wallets'));
  app.use('/api/disputes', require('./routes/disputes'));

  // MVP-01 — explicit Tow module (module registry, vehicles, documents,
  // settings). See docs/tow/TOW-MODULE-CONTRACT.md.
  const { createTowModule } = require('./modules/tow/http/mount');
  const towModule = createTowModule();
  app.use('/api/tow', towModule.publicRouter);
  app.use('/api/admin/tow', towModule.adminRouter);

  // Trilhas legadas mantidas por compatibilidade controlada.
  mountLegacyRoutes(app);

  // Catch-all para rotas não encontradas
  app.use('*', (req, res) => {
    console.log(`Rota não encontrada: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
      success: false,
      message: 'Rota não encontrada no backend da API'
    });
  });

  // Error handling middleware
  app.use((error, req, res, next) => {
    console.error('Erro no servidor:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  });

  return app;
}

module.exports = { createApp };
