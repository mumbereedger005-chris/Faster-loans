'use strict';
// ================================================================
//  FASTER LOANS UGANDA — MAIN SERVER
//  Node.js / Express | Timezone: Africa/Kampala (EAT = UTC+3)
// ================================================================
process.env.TZ = 'Africa/Kampala'; // Set Uganda EAT for entire process
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');

const db           = require('./db/db');
const logger       = require('./services/loggerService');
const errorHandler = require('./middleware/errorHandler');
const { startScheduler } = require('./scheduler/autoDebit');

// ── Routes ──────────────────────────────────────────────────────
const authRoutes    = require('./routes/auth');
const loanRoutes    = require('./routes/loans');
const paymentRoutes = require('./routes/payments');
const adminRoutes   = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── HTTPS redirect (production) ──────────────────────────────────
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' &&
      req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ── Security headers ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return cb(null, true);
    }
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

// ── Body parsing ─────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── HTTP request logging ─────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) },
  skip:   (req) => req.url === '/api/health',
}));

// ── Global rate limit ────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
}));

// ── Static file uploads ──────────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
// NOTE: Do NOT serve uploads publicly — serve through authenticated endpoint
// app.use('/uploads', express.static(uploadDir)); // intentionally disabled

// ── Uganda EAT — inject server time into every response ──────────
app.use((req, res, next) => {
  // Any handler can call req.nowEAT() to get the current Uganda datetime
  req.nowEAT = () => {
    const now = new Date();
    // Africa/Kampala is always UTC+3 (no DST)
    return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  };
  req.nowEATString = () => req.nowEAT().toISOString().replace('T', ' ').substring(0, 19);
  next();
});

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'Faster Loans Uganda API',
    status:  'running',
    time_eat: req.nowEATString(),
    timezone: 'Africa/Kampala (EAT UTC+3)',
    env:  process.env.NODE_ENV,
  });
});

// ── Uganda server clock endpoint (used by all frontend pages) ─────
app.get('/api/clock', (req, res) => {
  const eat = req.nowEAT();
  res.json({
    success:   true,
    iso:       eat.toISOString(),
    display:   eat.toLocaleString('en-UG', { timeZone: 'Africa/Kampala', dateStyle: 'full', timeStyle: 'medium' }),
    date:      eat.toLocaleDateString('en-UG', { timeZone: 'Africa/Kampala' }),
    time:      eat.toLocaleTimeString('en-UG', { timeZone: 'Africa/Kampala' }),
    day:       eat.getDate(),
    month:     eat.getMonth() + 1,
    year:      eat.getFullYear(),
    timezone:  'Africa/Kampala',
    offset:    'UTC+3 (EAT)',
  });
});

// ── Mount routes ─────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/loans',    loanRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin',    adminRoutes);

// ── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` });
});

// ── Central error handler ────────────────────────────────────────
app.use(errorHandler);

// ── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  logger.info(`🚀  Faster Loans Uganda API running on port ${PORT}`);
  logger.info(`🕐  Uganda Time (EAT): ${eat.toISOString().replace('T',' ').substring(0,19)}`);
  logger.info(`🌍  Environment: ${process.env.NODE_ENV}`);

  // Start auto-debit scheduler (cron jobs for 25th reminder + 28th debit)
  startScheduler();
});

module.exports = app;
