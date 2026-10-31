const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const prisma = require('../../database/prisma');
const { sha256, randomToken } = require('../../utils/crypto');
const { unauthorized, badRequest } = require('../../utils/errors');
const audit = require('../../services/audit');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Pre-computed hash so unknown emails take the same time as wrong passwords (no user enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const signAccess = (user) =>
  jwt.sign({ sub: user.id, cid: user.companyId || null }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL, issuer: 'seeda-hrms', algorithm: 'HS256' });

const issueRefresh = async (tx, userId, family, meta) => {
  const token = randomToken(48);
  const row = await tx.refreshToken.create({
    data: {
      userId, tokenHash: sha256(token), family: family || crypto.randomUUID(),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000), ip: meta.ip, userAgent: meta.userAgent,
    },
  });
  return { token, row };
};

const passwordPolicy = (pw) => typeof pw === 'string' && pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw);

const login = async ({ email, password }, meta) => {
  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null } });
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw unauthorized('INVALID_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw unauthorized('ACCOUNT_LOCKED');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null },
    });
    await audit.record({ companyId: user.companyId, userId: user.id, ip: meta.ip, userAgent: meta.userAgent }, { action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id });
    throw unauthorized(failed >= MAX_FAILED ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_DISABLED');

  const { token } = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    return issueRefresh(tx, user.id, null, meta);
  });
  await audit.record({ companyId: user.companyId, userId: user.id, userName: user.displayName, ip: meta.ip, userAgent: meta.userAgent }, { action: 'LOGIN', entityType: 'User', entityId: user.id });
  return { accessToken: signAccess(user), refreshToken: token };
};

// Rotation: each refresh token is single-use. Presenting a revoked token = theft signal → revoke the whole family.
const refresh = async (token, meta) => {
  if (!token) throw unauthorized('REFRESH_INVALID');
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row) throw unauthorized('REFRESH_INVALID');
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { family: row.family, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit.record({ companyId: row.user.companyId, userId: row.userId, ip: meta.ip }, { action: 'REFRESH_TOKEN_REUSE', entityType: 'User', entityId: row.userId });
    throw unauthorized('REFRESH_INVALID');
  }
  if (row.expiresAt < new Date() || row.user.status !== 'ACTIVE' || row.user.deletedAt) throw unauthorized('REFRESH_INVALID');

  const next = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) throw unauthorized('REFRESH_INVALID'); // concurrent use
    const issued = await issueRefresh(tx, row.userId, row.family, meta);
    await tx.refreshToken.update({ where: { id: row.id }, data: { replacedBy: issued.row.id } });
    return issued;
  });
  return { accessToken: signAccess(row.user), refreshToken: next.token };
};

const logout = async (token) => {
  if (!token) return;
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (row) await prisma.refreshToken.updateMany({ where: { family: row.family, revokedAt: null }, data: { revokedAt: new Date() } });
};

const changePassword = async (ctx, { currentPassword, newPassword }) => {
  const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest('INVALID_CREDENTIALS');
  if (!passwordPolicy(newPassword)) throw badRequest('WEAK_PASSWORD');
  if (currentPassword === newPassword) throw badRequest('SAME_PASSWORD');
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12), passwordChangedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit.record(ctx, { action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id });
};

const me = async (ctx) => {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: {
      id: true, email: true, displayName: true, language: true, isSuperAdmin: true, companyId: true,
      employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true, branchId: true, departmentId: true, position: { select: { titleAr: true, titleEn: true } } } },
    },
  });
  return {
    ...user,
    company: ctx.company ? { id: ctx.company.id, nameAr: ctx.company.nameAr, nameEn: ctx.company.nameEn, currency: ctx.company.currency, timezone: ctx.company.timezone, isDemo: ctx.company.isDemo, logoFileId: ctx.company.logoFileId, weekendDays: ctx.company.weekendDays } : null,
    roles: ctx.roleCodes,
    permissions: ctx.isSuperAdmin ? ['*'] : [...ctx.permissions.keys()],
  };
};

module.exports = { login, refresh, logout, changePassword, me, passwordPolicy, signAccess };
