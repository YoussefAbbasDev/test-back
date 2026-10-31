const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./database/prisma');
const errorHandler = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/auth');
const { buildOpenApi } = require('./docs/openapi');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return cb(null, true);
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language', 'X-Company-Id', 'X-Device-Key'],
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000, limit: env.isTest ? 100000 : env.RATE_LIMIT_PER_MIN, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests' } }),
}));

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

const v1 = express.Router();
v1.use('/auth', require('./modules/auth/auth.routes'));
// attendance has device-authenticated endpoints (kiosk / hardware) mounted before user auth
v1.use('/attendance', require('./modules/attendance/attendance.routes'));

v1.use(authenticate);
v1.use('/dashboard', require('./modules/dashboard/dashboard.routes'));
v1.use('/employees', require('./modules/employees/employees.routes'));
v1.use('/organization', require('./modules/organization/organization.routes'));
v1.use('/shifts', require('./modules/shifts/shifts.routes'));
v1.use('/leaves', require('./modules/leaves/leaves.routes'));
v1.use('/payroll', require('./modules/payroll/payroll.routes'));
v1.use('/payslips', require('./modules/payslips/payslips.routes'));
v1.use('/commissions', require('./modules/commissions/commissions.routes'));
const finance = require('./modules/loans/loans.routes');
v1.use('/advances', finance.advances);
v1.use('/loans', finance.loans);
v1.use('/finance', finance.finance);
v1.use('/settings', require('./modules/settings/settings.routes'));
v1.use('/', require('./modules/system/system.routes'));

app.use('/api/v1', v1);

const openapi = buildOpenApi(app);
app.get('/api/docs.json', (req, res) => res.json(openapi));
app.use('/api/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'SEEDA HRMS API' }));

app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
app.use(errorHandler);

module.exports = app;
