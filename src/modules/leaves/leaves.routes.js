const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, date, optDate, listQuery, optMoney, money } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { notFound, forbidden } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D } = require('../../utils/money');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere, assertEmployeeAccess } = require('../../services/scope');
const { empName } = require('../../services/common');
const approvals = require('../../services/approvals');
const exporter = require('../../services/exporter');
const engine = require('../../engines/leave');
const service = require('./leaves.service');

const settings = { view: 'leaves.view', create: 'leaves.settings', edit: 'leaves.settings', delete: 'leaves.settings' };
const CATEGORIES = ['ANNUAL', 'SICK', 'EMERGENCY', 'MARRIAGE', 'BEREAVEMENT', 'MATERNITY', 'PATERNITY', 'UNPAID', 'PUBLIC_HOLIDAY', 'CUSTOM'];

router.use('/types', crudRouter({
  model: 'leaveType', entity: 'LeaveType', perm: settings, searchFields: ['code', 'nameAr', 'nameEn'], orderBy: { code: 'asc' },
  filters: { status: (v) => ({ status: v }) },
  createSchema: z.object({
    code: z.string().trim().min(1).max(40), nameAr: str(150), nameEn: str(150), category: z.enum(CATEGORIES).default('CUSTOM'), isPaid: z.boolean().default(true),
    payPercent: z.coerce.number().min(0).max(100).default(100), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  }),
  toData: (b) => ({ ...b, ...(b.isPaid === false ? { payPercent: 0 } : {}) }),
  beforeDelete: async (row, ctx) => {
    if (await prisma.leaveRequest.count({ where: { companyId: ctx.companyId, leaveTypeId: row.id } })) throw require('../../utils/errors').conflict('RELATED_RECORDS_EXIST');
  },
}));

const policySchema = z.object({
  leaveTypeId: z.string().uuid(), name: str(150), annualEntitlement: money, accrualMethod: z.enum(['UPFRONT', 'MONTHLY', 'NONE']), accrualFrequency: z.enum(['YEARLY', 'MONTHLY']).optional(),
  prorateFirstYear: z.boolean().optional(), carryForwardMax: optMoney, maxBalance: optMoney, minRequestDays: optMoney, maxRequestDays: optMoney,
  attachmentRequired: z.boolean().optional(), attachmentAfterDays: optMoney, countWeekends: z.boolean().optional(), countHolidays: z.boolean().optional(),
  requiresBalance: z.boolean().optional(), allowNegativeBalance: z.boolean().optional(), reserveOnPending: z.boolean().optional(),
  minServiceMonths: z.coerce.number().int().min(0).nullable().optional(), genderRestriction: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  applicableBranchIds: z.array(z.string().uuid()).nullable().optional(), applicableEmploymentTypes: z.array(z.string()).nullable().optional(),
  allowCancellationAfterStart: z.boolean().optional(), workflowId: optId, effectiveFrom: date, effectiveTo: optDate, status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
router.use('/policies', crudRouter({
  model: 'leavePolicy', entity: 'LeavePolicy', perm: settings, searchFields: ['name'], orderBy: { effectiveFrom: 'desc' },
  include: { leaveType: { select: { id: true, code: true, nameAr: true, nameEn: true } } }, filters: { leaveTypeId: (v) => ({ leaveTypeId: v }) },
  createSchema: policySchema, updateSchema: policySchema.partial(),
  toData: (b) => ({ ...b, ...(b.effectiveFrom ? { effectiveFrom: toDateOnly(b.effectiveFrom) } : {}), ...('effectiveTo' in b ? { effectiveTo: b.effectiveTo ? toDateOnly(b.effectiveTo) : null } : {}) }),
}));

const include = {
  employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true, branchId: true, departmentId: true, department: { select: { nameAr: true, nameEn: true } }, branch: { select: { nameAr: true, nameEn: true } } } },
  leaveType: { select: { id: true, code: true, nameAr: true, nameEn: true, color: true, isPaid: true, category: true } },
};

const requestsWhere = async (ctx, q) => {
  const and = [{ companyId: ctx.companyId }];
  if (q.mine === 'true') and.push({ employeeId: ctx.employeeId || '-' });
  else and.push({ employee: await employeeWhere(ctx, 'leaves.view') });
  if (q.status) and.push({ status: { in: q.status.split(',') } });
  if (q.employeeId) and.push({ employeeId: q.employeeId });
  if (q.leaveTypeId) and.push({ leaveTypeId: q.leaveTypeId });
  if (q.branchId) and.push({ employee: { branchId: q.branchId } });
  if (q.departmentId) and.push({ employee: { departmentId: q.departmentId } });
  if (q.from) and.push({ endDate: { gte: toDateOnly(q.from) } });
  if (q.to) and.push({ startDate: { lte: toDateOnly(q.to) } });
  if (q.search) and.push({ employee: { OR: [{ firstName: { contains: q.search } }, { lastName: { contains: q.search } }, { employeeNumber: { contains: q.search } }, { fullNameAr: { contains: q.search } }] } });
  return { AND: and };
};

const columns = [
  { header: 'Employee ID', value: (r) => r.employee.employeeNumber }, { header: 'Employee', value: (r) => empName(r.employee) }, { header: 'Department', value: (r) => r.employee.department?.nameEn },
  { header: 'Leave type', value: (r) => r.leaveType.nameEn }, { header: 'From', value: (r) => fmtDate(r.startDate) }, { header: 'To', value: (r) => fmtDate(r.endDate) },
  { header: 'Days', value: (r) => Number(r.days) }, { header: 'Status', key: 'status' }, { header: 'Reason', key: 'reason' },
];

router.get('/requests', authorize('leaves.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = await requestsWhere(req.ctx, q);
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'leaves.export')) throw forbidden('PERMISSION_DENIED');
    const rows = await prisma.leaveRequest.findMany({ where, include, orderBy: { startDate: 'desc' }, take: 20000 });
    return exporter.send(res, q.format, { title: 'Leave requests', filename: 'leave-requests', columns, rows });
  }
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.leaveRequest.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.leaveRequest.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));

router.get('/requests/:id', authorize('leaves.view'), ah(async (req, res) => {
  const r = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId }, include: { ...include, policy: true } });
  if (!r) throw notFound();
  await assertEmployeeAccess(req.ctx, r.employeeId, 'leaves.view');
  res.json({ ...r, approvals: await approvals.timeline(req.ctx.companyId, 'LEAVE', r.id), cancellation: await approvals.timeline(req.ctx.companyId, 'LEAVE_CANCELLATION', r.id) });
}));

const requestSchema = z.object({
  employeeId: optId, leaveTypeId: z.string().uuid(), startDate: date, endDate: date, halfDay: z.boolean().optional(), reason: optStr(1000),
  attachmentId: optId, emergencyContact: optStr(200), handoverNotes: optStr(1000), draft: z.boolean().optional(),
}).refine((v) => v.startDate <= v.endDate, { message: 'End date must be on/after start date', path: ['endDate'] });

router.post('/requests/preview', authorize('leaves.view'), validate({ body: z.object({ employeeId: optId, leaveTypeId: z.string().uuid(), startDate: date, endDate: date, halfDay: z.boolean().optional() }) }), ah(async (req, res) => res.json(await service.preview(req.ctx, req.body))));
router.post('/requests', authorize(['leaves.create', 'leaves.view']), validate({ body: requestSchema }), ah(async (req, res) => {
  // self-service needs leaves.create (Employee role has it); requests for others need leaves.edit (checked in service)
  if (!hasPermission(req.ctx, 'leaves.create')) throw forbidden('PERMISSION_DENIED', { permission: 'leaves.create' });
  res.status(201).json(await service.create(req.ctx, req.body));
}));
router.post('/requests/:id/submit', authorize('leaves.create'), ah(async (req, res) => res.json(await service.submitDraft(req.ctx, req.params.id))));
router.post('/requests/:id/withdraw', authorize('leaves.view'), ah(async (req, res) => res.json(await service.withdraw(req.ctx, req.params.id))));
router.post('/requests/:id/cancel', authorize('leaves.view'), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => res.json(await service.requestCancellation(req.ctx, req.params.id, req.body.reason))));

// Approve / reject through the generic approval task assigned to the caller
const decide = (decision) => ah(async (req, res) => {
  const r = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId } });
  if (!r) throw notFound();
  const entityType = r.status === 'CANCELLATION_PENDING' ? 'LEAVE_CANCELLATION' : 'LEAVE';
  const task = await prisma.approvalTask.findFirst({ where: { approverUserId: req.ctx.userId, status: 'PENDING', instance: { companyId: req.ctx.companyId, entityType, entityId: r.id, status: 'PENDING' } } });
  if (!task) throw forbidden('NOT_YOUR_APPROVAL');
  res.json(await approvals.act(req.ctx, task.id, decision, req.body?.comment));
});
router.post('/requests/:id/approve', authorize('leaves.approve'), validate({ body: z.object({ comment: optStr(1000) }) }), decide('APPROVE'));
router.post('/requests/:id/reject', authorize('leaves.reject'), validate({ body: z.object({ comment: str(1000) }) }), decide('REJECT'));

// Balances
router.get('/balances', authorize('leaves.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const year = Number(q.year) || new Date().getUTCFullYear();
  if (q.employeeId || q.mine === 'true') {
    const employeeId = q.employeeId || req.ctx.employeeId;
    await assertEmployeeAccess(req.ctx, employeeId, 'leaves.view');
    return res.json({ year, items: await service.balancesFor(req.ctx, employeeId, year) });
  }
  const where = { companyId: req.ctx.companyId, year, employee: await employeeWhere(req.ctx, 'leaves.view'), ...(q.leaveTypeId ? { leaveTypeId: q.leaveTypeId } : {}) };
  const rows = await prisma.leaveBalance.findMany({ where, include: { employee: include.employee, leaveType: include.leaveType }, orderBy: [{ employee: { employeeNumber: 'asc' } }], take: 20000 });
  const items = rows.map((b) => ({ ...b, current: engine.currentBalance(b).toFixed(2), available: engine.availableBalance(b).toFixed(2) }));
  if (q.format && q.format !== 'json') {
    return exporter.send(res, q.format, {
      title: `Leave balances ${year}`, filename: `leave-balances-${year}`, rows: items,
      columns: [{ header: 'Employee ID', value: (r) => r.employee.employeeNumber }, { header: 'Employee', value: (r) => empName(r.employee) }, { header: 'Type', value: (r) => r.leaveType.nameEn }, { header: 'Opening', value: (r) => Number(r.openingBalance) }, { header: 'Accrued', value: (r) => Number(r.accrued) }, { header: 'Carried', value: (r) => Number(r.carriedForward) }, { header: 'Adjustments', value: (r) => Number(r.adjustments) }, { header: 'Used', value: (r) => Number(r.used) }, { header: 'Pending', value: (r) => Number(r.pending) }, { header: 'Current', key: 'current' }],
    });
  }
  res.json({ year, items });
}));
router.get('/balances/:id/transactions', authorize('leaves.view'), ah(async (req, res) => {
  const bal = await prisma.leaveBalance.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId } });
  if (!bal) throw notFound();
  await assertEmployeeAccess(req.ctx, bal.employeeId, 'leaves.view');
  res.json({ items: await prisma.leaveBalanceTransaction.findMany({ where: { balanceId: bal.id }, orderBy: { createdAt: 'desc' } }) });
}));
router.post('/balances/adjust', authorize('leaves.edit'),
  validate({ body: z.object({ employeeId: z.string().uuid(), leaveTypeId: z.string().uuid(), year: z.coerce.number().int().min(2000).max(2100), days: money, type: z.enum(['ADJUSTMENT', 'OPENING']).default('ADJUSTMENT'), reason: str(500) }) }),
  ah(async (req, res) => res.json(await service.adjustBalance(req.ctx, req.body))));
router.post('/balances/carry-forward', authorize('leaves.settings'), validate({ body: z.object({ fromYear: z.coerce.number().int().min(2000).max(2100) }) }), ah(async (req, res) => res.json(await service.carryForward(req.ctx, req.body.fromYear))));

// Calendar with conflicts (overlapping leaves in the same department)
router.get('/calendar', authorize('leaves.view'), validate({ query: z.object({ from: date, to: date, branchId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() }) }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = await requestsWhere(req.ctx, { ...q, status: 'APPROVED,SUBMITTED,PENDING_MANAGER,PENDING_HR,CANCELLATION_PENDING' });
  const items = await prisma.leaveRequest.findMany({ where, include, orderBy: { startDate: 'asc' } });
  const conflicts = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]; const b = items[j];
      if (a.employee.departmentId && a.employee.departmentId === b.employee.departmentId && a.startDate <= b.endDate && b.startDate <= a.endDate && a.employeeId !== b.employeeId) {
        conflicts.push({ a: a.id, b: b.id, department: a.employee.department?.nameEn, from: fmtDate(a.startDate > b.startDate ? a.startDate : b.startDate), to: fmtDate(a.endDate < b.endDate ? a.endDate : b.endDate) });
      }
    }
  }
  const holidays = await prisma.holiday.findMany({ where: { companyId: req.ctx.companyId, date: { gte: toDateOnly(q.from), lte: toDateOnly(q.to) } } });
  res.json({ items, conflicts, holidays });
}));

// Reports
router.get('/reports/:type', authorize('leaves.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const year = Number(q.year) || new Date().getUTCFullYear();
  const from = q.from || `${year}-01-01`;
  const to = q.to || `${year}-12-31`;
  const scope = await employeeWhere(req.ctx, 'leaves.view');
  let rows; let cols;
  const t = req.params.type;
  if (t === 'usage' || t === 'pending' || t === 'unpaid') {
    const status = t === 'pending' ? ['SUBMITTED', 'PENDING_MANAGER', 'PENDING_HR', 'CANCELLATION_PENDING'] : ['APPROVED'];
    rows = await prisma.leaveRequest.findMany({ where: { companyId: req.ctx.companyId, employee: scope, status: { in: status }, startDate: { lte: toDateOnly(to) }, endDate: { gte: toDateOnly(from) }, ...(t === 'unpaid' ? { leaveType: { isPaid: false } } : {}) }, include, orderBy: { startDate: 'asc' } });
    cols = columns;
  } else if (t === 'by-department' || t === 'by-branch') {
    const reqs = await prisma.leaveRequest.findMany({ where: { companyId: req.ctx.companyId, employee: scope, status: 'APPROVED', startDate: { lte: toDateOnly(to) }, endDate: { gte: toDateOnly(from) } }, include });
    const map = new Map();
    for (const r of reqs) {
      const key = t === 'by-branch' ? r.employee.branch?.nameEn || '-' : r.employee.department?.nameEn || '-';
      const acc = map.get(key) || { group: key, requests: 0, days: D(0), employees: new Set() };
      acc.requests++; acc.days = acc.days.plus(r.days); acc.employees.add(r.employeeId);
      map.set(key, acc);
    }
    rows = [...map.values()].map((r) => ({ group: r.group, requests: r.requests, days: r.days.toFixed(1), employees: r.employees.size }));
    cols = [{ header: t === 'by-branch' ? 'Branch' : 'Department', key: 'group' }, { header: 'Requests', key: 'requests' }, { header: 'Days', key: 'days' }, { header: 'Employees', key: 'employees' }];
  } else if (t === 'forecast') {
    // Annual leave forecast: projected year-end balance from accrual policy minus used & pending
    const bals = await prisma.leaveBalance.findMany({ where: { companyId: req.ctx.companyId, year, employee: scope, leaveType: { category: 'ANNUAL' } }, include: { employee: true, leaveType: true } });
    rows = [];
    for (const b of bals) {
      const policy = await service.resolvePolicy(b.employee, b.leaveTypeId, `${year}-12-31`);
      const yearEnd = policy ? engine.accruedFor({ entitlement: policy.annualEntitlement, method: policy.accrualMethod, hireDate: b.employee.hireDate, year, asOf: `${year}-12-31`, prorateFirstYear: policy.prorateFirstYear, maxBalance: policy.maxBalance }) : D(b.accrued);
      const projected = D(b.openingBalance).plus(yearEnd).plus(b.adjustments).plus(b.carriedForward).minus(b.used).minus(b.pending);
      rows.push({ employeeNumber: b.employee.employeeNumber, employee: empName(b.employee), current: engine.currentBalance(b).toFixed(2), accruedToYearEnd: yearEnd.toFixed(2), used: D(b.used).toFixed(2), pending: D(b.pending).toFixed(2), projectedYearEnd: projected.toFixed(2), carryForwardCap: policy?.carryForwardMax?.toString() ?? '-' });
    }
    cols = [{ header: 'Employee ID', key: 'employeeNumber' }, { header: 'Employee', key: 'employee' }, { header: 'Current', key: 'current' }, { header: 'Accrued (year end)', key: 'accruedToYearEnd' }, { header: 'Used', key: 'used' }, { header: 'Pending', key: 'pending' }, { header: 'Projected year end', key: 'projectedYearEnd' }, { header: 'CF cap', key: 'carryForwardCap' }];
  } else if (t === 'balances') {
    return res.redirect(307, `../balances?year=${year}${q.format ? `&format=${q.format}` : ''}`);
  } else throw notFound();
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'leaves.export')) throw forbidden('PERMISSION_DENIED');
    return exporter.send(res, q.format, { title: `Leaves — ${t}`, subtitle: `${from} → ${to}`, filename: `leaves-${t}`, columns: cols, rows });
  }
  res.json({ from, to, ...exporter.table(cols, rows) });
}));

module.exports = router;
