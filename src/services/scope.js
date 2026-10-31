// Row-level data scope. Every list/read of employee-linked data goes through employeeWhere().
const prisma = require('../database/prisma');
const { SCOPE_RANK } = require('../config/permissions');
const { forbidden, notFound } = require('../utils/errors');

const NONE = { id: '00000000-0000-0000-0000-000000000000' };

const scopeOf = (ctx, permission) => {
  if (ctx.isSuperAdmin) return SCOPE_RANK.COMPANY;
  const list = Array.isArray(permission) ? permission : [permission];
  return Math.max(0, ...list.map((p) => ctx.permissions.get(p) || 0));
};

// Builds a Prisma `where` for the Employee model limited to what ctx may see for `permission`.
const employeeWhere = async (ctx, permission) => {
  const rank = scopeOf(ctx, permission);
  const base = { companyId: ctx.companyId };
  if (rank >= SCOPE_RANK.COMPANY) return base;
  const emp = ctx.employee;
  if (!emp || rank === 0) return { ...base, ...NONE };

  if (rank === SCOPE_RANK.BRANCH) {
    const managed = await prisma.branch.findMany({ where: { companyId: ctx.companyId, managerId: emp.id }, select: { id: true } });
    const ids = [...new Set([...(ctx.roleBranchIds.length ? ctx.roleBranchIds : [emp.branchId]), ...managed.map((b) => b.id)].filter(Boolean))];
    return { ...base, OR: [{ branchId: { in: ids } }, { id: emp.id }] };
  }
  if (rank === SCOPE_RANK.DEPARTMENT) {
    const managed = await prisma.department.findMany({ where: { companyId: ctx.companyId, managerId: emp.id }, select: { id: true } });
    let ids = [...new Set([emp.departmentId, ...managed.map((d) => d.id)].filter(Boolean))];
    // include child units (sections) of managed departments
    const children = await prisma.department.findMany({ where: { companyId: ctx.companyId, parentId: { in: ids } }, select: { id: true } });
    ids = [...new Set([...ids, ...children.map((c) => c.id)])];
    return { ...base, OR: [{ departmentId: { in: ids } }, { sectionId: { in: ids } }, { id: emp.id }] };
  }
  if (rank === SCOPE_RANK.TEAM) {
    const led = await prisma.team.findMany({ where: { companyId: ctx.companyId, leaderId: emp.id }, select: { id: true } });
    const ids = [...new Set([emp.teamId, ...led.map((t) => t.id)].filter(Boolean))];
    return { ...base, OR: [{ teamId: { in: ids } }, { id: emp.id }] };
  }
  if (rank === SCOPE_RANK.ASSIGNED) {
    return { ...base, OR: [{ managerId: emp.id }, { id: emp.id }] };
  }
  return { ...base, id: emp.id }; // OWN
};

// For tables that reference an employee: { employee: <employeeWhere> } or a list of ids
const employeeIdsWhere = async (ctx, permission) => {
  const where = await employeeWhere(ctx, permission);
  if (scopeOf(ctx, permission) >= SCOPE_RANK.COMPANY) return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, employee: where };
};

// Throws 404 when the employee is outside the company or 403 when outside the caller's scope.
const assertEmployeeAccess = async (ctx, employeeId, permission) => {
  const exists = await prisma.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId, deletedAt: null }, select: { id: true } });
  if (!exists) throw notFound('EMPLOYEE_NOT_FOUND');
  const where = await employeeWhere(ctx, permission);
  const allowed = await prisma.employee.count({ where: { AND: [where, { id: employeeId }] } });
  if (!allowed) throw forbidden('OUT_OF_SCOPE');
};

const isOwnOnly = (ctx, permission) => scopeOf(ctx, permission) <= SCOPE_RANK.OWN;

module.exports = { scopeOf, employeeWhere, employeeIdsWhere, assertEmployeeAccess, isOwnOnly, SCOPE_RANK };
