const prisma = require('../database/prisma');
const { badRequest, notFound } = require('../utils/errors');

// Atomic per-company counters (employee numbers, payroll run numbers, payslip numbers…)
const nextSequence = async (tx, companyId, name) => {
  await tx.$executeRaw`INSERT INTO sequences (companyId, name, value) VALUES (${companyId}, ${name}, 1)
    ON DUPLICATE KEY UPDATE value = value + 1`;
  const row = await tx.sequence.findUnique({ where: { companyId_name: { companyId, name } } });
  return row.value;
};

const formatNumber = (prefix, n, width = 5) => `${prefix}-${String(n).padStart(width, '0')}`;

// Verifies that every referenced id belongs to the caller's company (prevents cross-tenant linking).
const MODEL_FOR = {
  branchId: 'branch', departmentId: 'department', sectionId: 'department', parentId: 'department', teamId: 'team',
  positionId: 'jobPosition', gradeId: 'jobGrade', managerId: 'employee', employeeId: 'employee', leaderId: 'employee',
  defaultShiftId: 'shift', shiftId: 'shift', attendancePolicyId: 'attendancePolicy', salaryStructureId: 'salaryStructure',
  leaveTypeId: 'leaveType', componentId: 'salaryComponent', workflowId: 'approvalWorkflow', reportsToPositionId: 'jobPosition',
  replacementId: 'employee',
};

const assertSameCompany = async (companyId, refs, tx = prisma) => {
  for (const [key, value] of Object.entries(refs)) {
    if (!value) continue;
    const model = MODEL_FOR[key];
    if (!model) continue;
    const ids = Array.isArray(value) ? value : [value];
    const count = await tx[model].count({ where: { id: { in: ids }, companyId } });
    if (count !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', { field: key });
  }
};

const findOwned = async (model, ctx, id, opts = {}) => {
  const row = await prisma[model].findFirst({ where: { id, companyId: ctx.companyId, ...(opts.where || {}) }, include: opts.include, select: opts.select });
  if (!row) throw notFound(opts.code || 'NOT_FOUND');
  return row;
};

const empName = (e, lang = 'en') => {
  if (!e) return '';
  if (lang === 'ar' && e.fullNameAr) return e.fullNameAr;
  return e.fullNameEn || [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');
};

const maskIban = (iban) => (iban ? `${iban.slice(0, 4)}${'*'.repeat(Math.max(0, iban.length - 8))}${iban.slice(-4)}` : null);

module.exports = { nextSequence, formatNumber, assertSameCompany, findOwned, empName, maskIban };
