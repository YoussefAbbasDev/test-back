const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const env = require('../../config/env');
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z } = require('../../utils/validate');
const { authenticate } = require('../../middleware/auth');
const service = require('./auth.service');

const COOKIE = 'seeda_rt';
// Refresh cookie: httpOnly (no JS access), SameSite=Strict + narrow path → not sent cross-site (CSRF-safe refresh)
const cookieOpts = () => {
  const isCrossSite = env.isProd || Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return {
    httpOnly: true,
    secure: isCrossSite || env.isProd,
    sameSite: isCrossSite ? 'none' : 'lax',
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400000,
  };
};

const tooMany = (req, res) => res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests' } });
// keyed by IP + e-mail so one office behind a shared NAT address does not lock everyone out
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: env.isTest ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany,
  keyGenerator: (req) => `${rateLimit.ipKeyGenerator ? rateLimit.ipKeyGenerator(req.ip) : req.ip}|${String(req.body?.email || '').toLowerCase()}`,
});
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: env.isTest ? 1000 : 600, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany });

const meta = (req) => ({ ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 300) });

router.post('/login', loginLimiter,
  validate({ body: z.object({ email: z.string().email().max(191), password: z.string().min(1).max(200) }) }),
  ah(async (req, res) => {
    const { accessToken, refreshToken } = await service.login(req.body, meta(req));
    res.cookie(COOKIE, refreshToken, cookieOpts());
    res.json({ accessToken });
  }));

router.post('/refresh', refreshLimiter, ah(async (req, res) => {
  const { accessToken, refreshToken } = await service.refresh(req.cookies?.[COOKIE], meta(req));
  res.cookie(COOKIE, refreshToken, cookieOpts());
  res.json({ accessToken });
}));

router.post('/logout', ah(async (req, res) => {
  await service.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, cookieOpts());
  res.status(204).end();
}));

router.get('/me', authenticate, ah(async (req, res) => res.json(await service.me(req.ctx))));

router.post('/change-password', authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }) }),
  ah(async (req, res) => {
    await service.changePassword(req.ctx, req.body);
    res.clearCookie(COOKIE, cookieOpts());
    res.status(204).end();
  }));

router.patch('/preferences', authenticate,
  validate({ body: z.object({ language: z.enum(['ar', 'en']) }) }),
  ah(async (req, res) => {
    await prisma.user.update({ where: { id: req.ctx.userId }, data: { language: req.body.language } });
    res.json({ language: req.body.language });
  }));

module.exports = router;
