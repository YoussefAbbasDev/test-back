const jwt = require('jsonwebtoken');
const env = require('../config/env');
const prisma = require('../database/prisma');
const { SCOPE_RANK } = require('../config/permissions');
const { unauthorized, forbidden, notFound } = require('../utils/errors');

const loadContext = async (userId, req) => {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    include: {
      employee: { select: { id: true, branchId: true, departmentId: true, sectionId: true, teamId: true, managerId: true, status: true } },
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  if (!user || user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_DISABLED');

  // Super admin works inside a company selected with X-Company-Id; everyone else is pinned to their own company.
  let companyId = user.companyId;
  if (user.isSuperAdmin) {
    companyId = req.get('x-company-id') || null;
  }
  let company = null;
  if (companyId) {
    company = await prisma.company.findFirst({ where: { id: companyId, deletedAt: null } });
    if (!company) throw notFound('COMPANY_NOT_FOUND');
  }

  // permission code → highest data-scope rank granted by any of the user's roles
  const permissions = new Map();
  const roleBranchIds = [];
  for (const ur of user.roles) {
    if (ur.branchId) roleBranchIds.push(ur.branchId);
    const rank = SCOPE_RANK[ur.role.dataScope] || 1;
    for (const rp of ur.role.permissions) {
      const code = rp.permission.code;
      if ((permissions.get(code) || 0) < rank) permissions.set(code, rank);
    }
  }

  return {
    userId: user.id,
    userName: user.displayName,
    email: user.email,
    isSuperAdmin: user.isSuperAdmin,
    companyId,
    company,
    tz: company?.timezone || 'Asia/Riyadh',
    currency: company?.currency || 'SAR',
    employee: user.employee,
    employeeId: user.employee?.id || null,
    roleCodes: user.roles.map((r) => r.role.code),
    roleBranchIds,
    permissions,
    language: user.language,
    ip: req.ip,
    userAgent: (req.get('user-agent') || '').slice(0, 300),
  };
};

const authenticate = async (req, res, next) => {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized('TOKEN_MISSING');
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'seeda-hrms' });
    } catch (e) {
      throw unauthorized(e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
    }
    req.ctx = await loadContext(payload.sub, req);
    next();
  } catch (e) {
    next(e);
  }
};

// Requires a selected company (super admins must pass X-Company-Id)
const requireCompany = (req, res, next) => {
  if (!req.ctx?.companyId) return next(forbidden('COMPANY_CONTEXT_REQUIRED'));
  next();
};

const hasPermission = (ctx, code) => ctx.isSuperAdmin || ctx.permissions.has(code);

// authorize('a.b') or authorize(['a.b','c.d']) → any of
const authorize = (codes) => {
  const list = Array.isArray(codes) ? codes : [codes];
  return (req, res, next) => {
    if (!req.ctx) return next(unauthorized());
    if (!req.ctx.companyId) return next(forbidden('COMPANY_CONTEXT_REQUIRED'));
    if (list.some((c) => hasPermission(req.ctx, c))) return next();
    next(forbidden('PERMISSION_DENIED', { permission: list.join(' | ') }));
  };
};

module.exports = { authenticate, authorize, requireCompany, hasPermission, loadContext };
