const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, date, money, optMoney, positiveMoney, listQuery } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { badRequest, forbidden, notFound } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere, assertEmployeeAccess } = require('../../services/scope');
const audit = require('../../services/audit');
const approvals = require('../../services/approvals');
const exporter = require('../../services/exporter');
const formula = require('../../engines/formula');
const service = require('./payroll.service');

const settingsPerm = { view: 'payroll.view', create: 'payroll.settings', edit: 'payroll.settings', delete: 'payroll.settings' };
const CATEGORIES = ['BASIC', 'HOUSING', 'TRANSPORT', 'ALLOWANCE', 'VARIABLE_ALLOWANCE', 'OVERTIME', 'COMMISSION', 'BONUS', 'OTHER_EARNING', 'ABSENCE', 'LATE', 'EARLY_LEAVE', 'UNPAID_LEAVE', 'ADVANCE', 'LOAN', 'PENALTY', 'GOSI', 'OTHER_DEDUCTION'];
const METHODS = ['FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_COMPONENT', 'ATTENDANCE_BASED', 'WORKING_DAYS', 'HOURLY', 'FORMULA', 'SYSTEM', 'EMPLOYEE_AMOUNT'];

const checkFormula = async (companyId, f) => {
  if (!f) return;
  const codes = (await prisma.salaryComponent.findMany({ where: { companyId }, select: { code: true } })).map((c) => c.code.toUpperCase());
  formula.validateFormula(f, [...codes, ...formula.SYSTEM_VARS]);
};

// ── Salary components ──
const componentSchema = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Uppercase letters, digits and _'), nameAr: str(150), nameEn: str(150),
  type: z.enum(['EARNING', 'DEDUCTION']), category: z.enum(CATEGORIES), calculationMethod: z.enum(METHODS).default('EMPLOYEE_AMOUNT'),
  value: optMoney, baseComponentCode: optStr(40), formula: optStr(500), isTaxable: z.boolean().optional(), includeInOvertimeBase: z.boolean().optional(),
  includeInEosBase: z.boolean().optional(), includeInGosiBase: z.boolean().optional(), includeInAbsenceBase: z.boolean().optional(), prorate: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(), effectiveFrom: z.string().optional().nullable(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
router.use('/components', crudRouter({
  model: 'salaryComponent', entity: 'SalaryComponent', perm: settingsPerm, searchFields: ['code', 'nameAr', 'nameEn'], orderBy: { sortOrder: 'asc' }, sortable: ['sortOrder', 'code'],
  filters: { type: (v) => ({ type: v }), status: (v) => ({ status: v }) },
  createSchema: componentSchema, updateSchema: componentSchema.partial(),
  toData: async (b, ctx, mode, before) => {
    if (before?.isSystem && (b.code || b.category || b.type)) throw badRequest('SYSTEM_ROLE');
    if (b.calculationMethod === 'FORMULA' || b.formula) await checkFormula(ctx.companyId, b.formula ?? before?.formula);
    return { ...b, ...(b.effectiveFrom ? { effectiveFrom: toDateOnly(b.effectiveFrom) } : {}) };
  },
  beforeDelete: async (row, ctx) => {
    if (row.isSystem) throw badRequest('SYSTEM_ROLE');
    const used = await prisma.employeeSalaryComponent.count({ where: { componentId: row.id } }) + await prisma.salaryStructureLine.count({ where: { componentId: row.id } });
    if (used) throw require('../../utils/errors').conflict('RELATED_RECORDS_EXIST');
  },
}));

// ── Salary structures (company-level rules: e.g. Housing = 25% of Basic) ──
router.use('/structures', crudRouter({
  model: 'salaryStructure', entity: 'SalaryStructure', perm: settingsPerm, searchFields: ['code', 'name'], orderBy: { code: 'asc' },
  include: { lines: { include: { component: { select: { code: true, nameAr: true, nameEn: true, type: true } } } }, _count: { select: { employees: true } } },
  createSchema: z.object({
    code: z.string().trim().min(1).max(40), name: str(150), isDefault: z.boolean().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    lines: z.array(z.object({ componentId: z.string().uuid(), calculationMethod: z.enum(METHODS).nullable().optional(), value: optMoney, baseComponentCode: optStr(40), formula: optStr(500) })).max(50).optional(),
  }),
  toData: async (b, ctx) => {
    const { lines, ...rest } = b;
    for (const l of lines || []) if (l.formula) await checkFormula(ctx.companyId, l.formula);
    return rest;
  },
  afterWrite: async (tx, row, ctx, body) => {
    if (body.lines) {
      const ids = body.lines.map((l) => l.componentId);
      if ((await tx.salaryComponent.count({ where: { id: { in: ids }, companyId: ctx.companyId } })) !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', { field: 'componentId' });
      await tx.salaryStructureLine.deleteMany({ where: { structureId: row.id } });
      if (body.lines.length) await tx.salaryStructureLine.createMany({ data: body.lines.map((l) => ({ ...l, structureId: row.id })) });
    }
    if (row.isDefault) await tx.salaryStructure.updateMany({ where: { companyId: ctx.companyId, id: { not: row.id } }, data: { isDefault: false } });
  },
}));

router.post('/formula/validate', authorize('payroll.settings'), validate({ body: z.object({ formula: str(500), sample: z.record(z.any()).optional() }) }), ah(async (req, res) => {
  await checkFormula(req.ctx.companyId, req.body.formula);
  let result = null;
  if (req.body.sample) {
    const vars = Object.fromEntries(Object.entries(req.body.sample).map(([k, v]) => [k.toUpperCase(), v]));
    const ast = formula.parse(req.body.formula);
    for (const v of formula.variablesOf(ast)) if (!(v in vars)) vars[v] = 0;
    result = formula.evaluate(ast, vars).toFixed(4);
  }
  res.json({ valid: true, result });
}));

// ── Settings ──
router.get('/settings', authorize('payroll.view'), ah(async (req, res) => res.json(await service.getSettings(req.ctx.companyId))));
router.put('/settings', authorize('payroll.settings'), validate({
  body: z.object({
    frequency: z.enum(['MONTHLY', 'WEEKLY', 'BIWEEKLY', 'CUSTOM']).optional(), cutoffDay: z.coerce.number().int().min(1).max(31).optional(), paymentDay: z.coerce.number().int().min(1).max(31).optional(),
    daysBasis: z.enum(['FIXED', 'CALENDAR']).optional(), fixedDaysPerMonth: z.coerce.number().int().min(20).max(31).optional(), standardDailyHours: money.optional(),
    overtimeBase: z.enum(['BASIC', 'FLAGGED_COMPONENTS']).optional(), overtimeRateWeekday: money.optional(), overtimeRateWeekend: money.optional(), overtimeRateHoliday: money.optional(),
    absenceDeductionEnabled: z.boolean().optional(), absenceDeductionBase: z.enum(['BASIC', 'FLAGGED_COMPONENTS']).optional(), lateDeductionMode: z.enum(['NONE', 'PER_MINUTE']).optional(),
    lateFreeMinutesPerPeriod: z.coerce.number().int().min(0).optional(), earlyLeaveDeduction: z.boolean().optional(), unpaidLeaveDeduction: z.boolean().optional(),
    roundingDecimals: z.coerce.number().int().min(0).max(4).optional(), roundingMode: z.enum(['HALF_UP', 'DOWN', 'UP']).optional(), maxDeductionPercent: optMoney,
    gosiEmployeeRate: money.optional(), gosiEmployerRate: money.optional(), gosiNationalities: z.array(z.string().max(60)).nullable().optional(),
    commissionInclusion: z.enum(['APPROVED_BY_PERIOD_END', 'ALL_PAYABLE']).optional(), workflowId: optId,
    bankExportFormat: z.array(z.object({ header: str(60), field: z.enum(['employeeNumber', 'name', 'bankName', 'iban', 'accountHolder', 'amount', 'currency', 'reference', 'paymentDate', 'runNumber']) })).max(20).nullable().optional(),
    eosRules: z.array(z.object({ fromYears: z.coerce.number().min(0), toYears: z.coerce.number().min(0).nullable().optional(), monthsPerYear: z.coerce.number().min(0).max(5), base: z.enum(['BASIC', 'FLAGGED']) })).max(10).nullable().optional(),
  }),
}), ah(async (req, res) => {
  const before = await service.getSettings(req.ctx.companyId);
  const updated = await prisma.payrollSetting.update({ where: { companyId: req.ctx.companyId }, data: req.body });
  await audit.record(req.ctx, { action: 'UPDATE', entityType: 'PayrollSetting', entityId: updated.id, before, after: updated });
  res.json(updated);
}));

// ── Periods ──
router.get('/periods', authorize('payroll.view'), ah(async (req, res) => {
  res.json({ items: await prisma.payrollPeriod.findMany({ where: { companyId: req.ctx.companyId }, orderBy: { startDate: 'desc' }, include: { _count: { select: { runs: true } } } }) });
}));
router.post('/periods', authorize('payroll.create'), validate({ body: z.object({ name: str(100), startDate: date, endDate: date, paymentDate: date, frequency: z.enum(['MONTHLY', 'WEEKLY', 'BIWEEKLY', 'CUSTOM']).optional() }) }),
  ah(async (req, res) => res.status(201).json(await service.createPeriod(req.ctx, req.body))));
router.post('/periods/:id/close', authorize('payroll.settings'), ah(async (req, res) => {
  const p = await prisma.payrollPeriod.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId } });
  if (!p) throw notFound();
  const open = await prisma.payrollRun.count({ where: { periodId: p.id, status: { in: ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'] } } });
  if (open) throw badRequest('INVALID_STATUS_TRANSITION', { from: 'OPEN', to: 'CLOSED' });
  await prisma.payrollPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
  await audit.record(req.ctx, { action: 'PAYROLL_PERIOD_CLOSED', entityType: 'PayrollPeriod', entityId: p.id });
  res.status(204).end();
}));

// ── Runs ──
router.get('/runs', authorize('payroll.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, ...(q.status ? { status: { in: q.status.split(',') } } : {}), ...(q.periodId ? { periodId: q.periodId } : {}) };
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([prisma.payrollRun.findMany({ where, include: { period: true }, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }), prisma.payrollRun.count({ where })]);
  res.json(paged(items, total, paging));
}));
router.post('/runs', authorize('payroll.create'), validate({ body: z.object({ periodId: z.string().uuid(), branchId: optId, employeeIds: z.array(z.string().uuid()).optional(), departmentIds: z.array(z.string().uuid()).optional(), notes: optStr(1000), type: z.enum(['REGULAR', 'OFF_CYCLE']).optional() }) }),
  ah(async (req, res) => res.status(201).json(await service.createRun(req.ctx, req.body))));

router.get('/runs/:id', authorize('payroll.view'), ah(async (req, res) => {
  const run = await service.loadRun(req.ctx, req.params.id);
  const employees = await prisma.payrollRunEmployee.findMany({ where: { runId: run.id }, include: { lines: { orderBy: { sortOrder: 'asc' } }, payslip: { select: { id: true, number: true, status: true } } }, orderBy: { createdAt: 'asc' } });
  const branch = run.branchId ? await prisma.branch.findUnique({ where: { id: run.branchId }, select: { nameAr: true, nameEn: true } }) : null;
  const lines = employees.filter((e) => e.status === 'INCLUDED').flatMap((e) => e.lines);
  const byCategory = {};
  for (const l of lines) byCategory[l.category] = D(byCategory[l.category] || 0).plus(l.amount).toFixed(2);
  const canSeeIban = hasPermission(req.ctx, 'employees.financial');
  res.json({
    ...run, branch, byCategory,
    employees: employees.map((e) => ({ ...e, snapshot: canSeeIban ? e.snapshot : { ...e.snapshot, iban: undefined } })),
    approvals: await approvals.timeline(req.ctx.companyId, 'PAYROLL', run.id),
    reversal: run.reversalOfId ? await prisma.payrollRun.findUnique({ where: { id: run.reversalOfId }, select: { id: true, runNumber: true } }) : null,
  });
}));
router.post('/runs/:id/calculate', authorize('payroll.edit'), ah(async (req, res) => res.json(await service.calculate(req.ctx, req.params.id))));
router.post('/:id/calculate', authorize('payroll.edit'), ah(async (req, res) => res.json(await service.calculate(req.ctx, req.params.id)))); // spec alias
router.post('/runs/:id/employees/:reId/exclude', authorize('payroll.edit'), validate({ body: z.object({ reason: str(500), status: z.enum(['EXCLUDED', 'ON_HOLD']).default('EXCLUDED') }) }),
  ah(async (req, res) => res.json(await service.setInclusion(req.ctx, req.params.id, req.params.reId, req.body))));
router.post('/runs/:id/employees/:reId/include', authorize('payroll.edit'), ah(async (req, res) => res.json(await service.setInclusion(req.ctx, req.params.id, req.params.reId, { status: 'INCLUDED' }))));
router.post('/runs/:id/submit', authorize('payroll.edit'), ah(async (req, res) => res.json(await service.submit(req.ctx, req.params.id))));

const decide = (decision) => ah(async (req, res) => {
  const task = await prisma.approvalTask.findFirst({ where: { approverUserId: req.ctx.userId, status: 'PENDING', instance: { companyId: req.ctx.companyId, entityType: 'PAYROLL', entityId: req.params.id, status: 'PENDING' } } });
  if (!task) throw forbidden('NOT_YOUR_APPROVAL');
  res.json(await approvals.act(req.ctx, task.id, decision, req.body?.comment));
});
router.post('/runs/:id/approve', authorize('payroll.approve'), validate({ body: z.object({ comment: optStr(1000) }) }), decide('APPROVE'));
router.post('/:id/approve', authorize('payroll.approve'), validate({ body: z.object({ comment: optStr(1000) }) }), decide('APPROVE')); // spec alias
router.post('/runs/:id/reject', authorize('payroll.reject'), validate({ body: z.object({ comment: str(1000) }) }), decide('REJECT'));
router.post('/runs/:id/lock', authorize('payroll.approve'), ah(async (req, res) => res.json(await service.lock(req.ctx, req.params.id))));
router.post('/:id/lock', authorize('payroll.approve'), ah(async (req, res) => res.json(await service.lock(req.ctx, req.params.id)))); // spec alias
router.post('/runs/:id/payments', authorize('payroll.approve'),
  validate({ body: z.object({ runEmployeeIds: z.array(z.string().uuid()).optional(), paidAt: z.string().optional(), reference: optStr(120), status: z.enum(['PAID', 'FAILED']).optional() }) }),
  ah(async (req, res) => res.json(await service.recordPayments(req.ctx, req.params.id, req.body))));
router.post('/runs/:id/reverse', authorize('payroll.approve'), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => res.status(201).json(await service.reverse(req.ctx, req.params.id, req.body.reason))));
router.post('/runs/:id/cancel', authorize('payroll.edit'), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => { await service.cancelRun(req.ctx, req.params.id, req.body.reason); res.status(204).end(); }));

// Bank transfer export (file only — no money is sent by the system)
router.get('/runs/:id/bank-file', authorize('payroll.export'), ah(async (req, res) => {
  const run = await service.loadRun(req.ctx, req.params.id);
  if (!['LOCKED', 'PAID', 'PARTIALLY_PAID'].includes(run.status)) throw badRequest('INVALID_STATUS_TRANSITION', { from: run.status, to: 'EXPORT' });
  const settings = await service.getSettings(req.ctx.companyId);
  const rows = await prisma.payrollRunEmployee.findMany({ where: { runId: run.id, status: 'INCLUDED' } });
  const fmt = settings.bankExportFormat?.length ? settings.bankExportFormat : [{ header: 'Employee No', field: 'employeeNumber' }, { header: 'Name', field: 'accountHolder' }, { header: 'Bank', field: 'bankName' }, { header: 'IBAN', field: 'iban' }, { header: 'Amount', field: 'amount' }, { header: 'Currency', field: 'currency' }, { header: 'Reference', field: 'reference' }];
  const value = (r, f) => ({ employeeNumber: r.snapshot.employeeNumber, name: r.snapshot.nameEn, bankName: r.snapshot.bankName, iban: r.snapshot.iban, accountHolder: r.snapshot.accountHolder, amount: Number(r.netSalary), currency: run.currency, reference: `${run.runNumber}-${r.snapshot.employeeNumber}`, paymentDate: fmtDate(run.period.paymentDate), runNumber: run.runNumber }[f]);
  await audit.record(req.ctx, { action: 'BANK_FILE_EXPORTED', entityType: 'PayrollRun', entityId: run.id, newValue: { rows: rows.length } });
  exporter.send(res, req.query.format === 'xlsx' ? 'xlsx' : 'csv', { title: `Bank transfer ${run.runNumber}`, filename: `bank-${run.runNumber}`, rows: rows.filter((r) => r.snapshot.paymentMethod === 'BANK'), columns: fmt.map((c) => ({ header: c.header, value: (r) => value(r, c.field) })) });
}));

// ── Adjustments (bonuses, penalties, corrections after lock) ──
router.get('/adjustments', authorize('payroll.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, ...(q.status ? { status: q.status } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) };
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.payrollAdjustment.findMany({ where, include: { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } } }, orderBy: { createdAt: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.payrollAdjustment.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));
router.post('/adjustments', authorize('payroll.create'),
  validate({ body: z.object({ employeeId: z.string().uuid(), type: z.enum(['EARNING', 'DEDUCTION']), category: z.enum(CATEGORIES).optional(), amount: positiveMoney, effectiveDate: date, reason: str(500), originalRunId: optId }) }),
  ah(async (req, res) => {
    await assertEmployeeAccess(req.ctx, req.body.employeeId, 'payroll.create');
    const a = await prisma.payrollAdjustment.create({ data: { ...req.body, category: req.body.category || (req.body.type === 'EARNING' ? 'OTHER_EARNING' : 'OTHER_DEDUCTION'), effectiveDate: toDateOnly(req.body.effectiveDate), companyId: req.ctx.companyId, createdById: req.ctx.userId } });
    await audit.record(req.ctx, { action: 'CREATE', entityType: 'PayrollAdjustment', entityId: a.id, employeeId: a.employeeId, after: a, reason: a.reason });
    res.status(201).json(a);
  }));
router.post('/adjustments/:id/:decision', authorize('payroll.approve'), ah(async (req, res) => {
  const a = await prisma.payrollAdjustment.findFirst({ where: { id: req.params.id, companyId: req.ctx.companyId, status: 'PENDING' } });
  if (!a) throw notFound();
  if (a.createdById === req.ctx.userId) throw forbidden('NOT_YOUR_APPROVAL');
  const status = { approve: 'APPROVED', cancel: 'CANCELLED' }[req.params.decision];
  if (!status) throw notFound();
  const u = await prisma.payrollAdjustment.update({ where: { id: a.id }, data: { status, approvedById: status === 'APPROVED' ? req.ctx.userId : null } });
  await audit.record(req.ctx, { action: `ADJUSTMENT_${status}`, entityType: 'PayrollAdjustment', entityId: a.id, employeeId: a.employeeId, before: a, after: u });
  res.json(u);
}));

// ── Dashboard ──
router.get('/dashboard', authorize('payroll.view'), ah(async (req, res) => {
  const ctx = req.ctx;
  const latest = await prisma.payrollRun.findFirst({ where: { companyId: ctx.companyId, type: 'REGULAR', status: { notIn: ['CANCELLED'] } }, orderBy: { createdAt: 'desc' }, include: { period: true } });
  const totalEmployees = await prisma.employee.count({ where: { companyId: ctx.companyId, deletedAt: null, status: { notIn: ['TERMINATED', 'RESIGNED', 'INACTIVE'] } } });
  let excluded = 0;
  if (latest) excluded = await prisma.payrollRunEmployee.count({ where: { runId: latest.id, status: { not: 'INCLUDED' } } });
  const pendingApprovals = await prisma.payrollRun.count({ where: { companyId: ctx.companyId, status: 'IN_REVIEW' } });
  const since = toDateOnly(dayjs().subtract(11, 'month').startOf('month').toDate());
  const runs = await prisma.payrollRun.findMany({ where: { companyId: ctx.companyId, status: { in: ['LOCKED', 'PAID', 'PARTIALLY_PAID', 'APPROVED', 'CALCULATED', 'IN_REVIEW'] }, period: { startDate: { gte: since } } }, include: { period: true }, orderBy: { createdAt: 'asc' } });
  const byMonth = new Map();
  for (const r of runs) {
    const key = dayjs(r.period.startDate).format('YYYY-MM');
    const acc = byMonth.get(key) || { month: key, net: D(0), earnings: D(0), deductions: D(0) };
    acc.net = acc.net.plus(r.totalNet); acc.earnings = acc.earnings.plus(r.totalEarnings); acc.deductions = acc.deductions.plus(r.totalDeductions);
    byMonth.set(key, acc);
  }
  res.json({
    latestRun: latest, totalEmployees, employeesIncluded: latest?.employeesCount || 0, employeesExcluded: excluded, pendingApprovals,
    trend: [...byMonth.values()].map((m) => ({ month: m.month, net: m.net.toFixed(2), earnings: m.earnings.toFixed(2), deductions: m.deductions.toFixed(2) })),
  });
}));

// ── Reports ──
router.get('/reports/:type', authorize('payroll.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const t = req.params.type;
  const runIds = q.runId ? [q.runId] : (await prisma.payrollRun.findMany({ where: { companyId: req.ctx.companyId, status: { in: ['LOCKED', 'PAID', 'PARTIALLY_PAID', 'APPROVED', 'CALCULATED', 'IN_REVIEW'] }, ...(q.periodId ? { periodId: q.periodId } : {}) }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: q.periodId ? 50 : 1 })).map((r) => r.id);
  const rows = await prisma.payrollRunEmployee.findMany({ where: { runId: { in: runIds }, companyId: req.ctx.companyId, status: 'INCLUDED' }, include: { lines: true, run: { select: { runNumber: true } } } });
  let items; let cols;
  const groupBy = (keyFn, label) => {
    const map = new Map();
    for (const r of rows) {
      const key = keyFn(r) || '-';
      const acc = map.get(key) || { group: key, employees: 0, basic: D(0), earnings: D(0), deductions: D(0), net: D(0), gosiEmployer: D(0) };
      acc.employees++; acc.basic = acc.basic.plus(r.basicSalary); acc.earnings = acc.earnings.plus(r.grossEarnings); acc.deductions = acc.deductions.plus(r.totalDeductions); acc.net = acc.net.plus(r.netSalary);
      map.set(key, acc);
    }
    items = [...map.values()].map((a) => ({ ...a, basic: a.basic.toFixed(2), earnings: a.earnings.toFixed(2), deductions: a.deductions.toFixed(2), net: a.net.toFixed(2), gosiEmployer: undefined }));
    cols = [{ header: label, key: 'group' }, { header: 'Employees', key: 'employees' }, { header: 'Basic', key: 'basic' }, { header: 'Earnings', key: 'earnings' }, { header: 'Deductions', key: 'deductions' }, { header: 'Net', key: 'net' }];
  };
  if (t === 'summary' || t === 'by-employee' || t === 'bank') {
    items = rows.map((r) => ({ employeeNumber: r.snapshot.employeeNumber, name: r.snapshot.nameEn, department: r.snapshot.departmentEn, branch: r.snapshot.branchEn, basic: r.basicSalary.toString(), gross: r.grossEarnings.toString(), deductions: r.totalDeductions.toString(), net: r.netSalary.toString(), bank: r.snapshot.bankName, iban: r.snapshot.ibanMasked, payment: r.paymentStatus, run: r.run.runNumber }));
    cols = t === 'bank'
      ? [{ header: 'Employee ID', key: 'employeeNumber' }, { header: 'Name', key: 'name' }, { header: 'Bank', key: 'bank' }, { header: 'IBAN', key: 'iban' }, { header: 'Net', key: 'net' }, { header: 'Payment', key: 'payment' }]
      : [{ header: 'Employee ID', key: 'employeeNumber' }, { header: 'Name', key: 'name' }, { header: 'Department', key: 'department' }, { header: 'Branch', key: 'branch' }, { header: 'Basic', key: 'basic' }, { header: 'Gross', key: 'gross' }, { header: 'Deductions', key: 'deductions' }, { header: 'Net', key: 'net' }];
  } else if (t === 'by-branch') groupBy((r) => r.snapshot.branchEn, 'Branch');
  else if (t === 'by-department' || t === 'cost-analysis') groupBy((r) => r.snapshot.departmentEn, 'Department');
  else if (['earnings', 'deductions', 'overtime', 'commissions'].includes(t)) {
    const filter = { earnings: (l) => l.type === 'EARNING', deductions: (l) => l.type === 'DEDUCTION', overtime: (l) => l.category === 'OVERTIME', commissions: (l) => l.category === 'COMMISSION' }[t];
    const map = new Map();
    for (const r of rows) for (const l of r.lines.filter(filter)) {
      const key = `${l.code}`;
      const acc = map.get(key) || { code: l.code, name: l.nameEn, category: l.category, employees: new Set(), amount: D(0) };
      acc.employees.add(r.employeeId); acc.amount = acc.amount.plus(l.amount);
      map.set(key, acc);
    }
    items = [...map.values()].map((a) => ({ code: a.code, name: a.name, category: a.category, employees: a.employees.size, amount: a.amount.toFixed(2) }));
    cols = [{ header: 'Code', key: 'code' }, { header: 'Component', key: 'name' }, { header: 'Category', key: 'category' }, { header: 'Employees', key: 'employees' }, { header: 'Amount', key: 'amount' }];
  } else if (t === 'comparison') {
    const runs = await prisma.payrollRun.findMany({ where: { companyId: req.ctx.companyId, type: 'REGULAR', status: { notIn: ['CANCELLED', 'DRAFT'] } }, include: { period: true }, orderBy: { createdAt: 'desc' }, take: 12 });
    items = runs.reverse().map((r) => ({ run: r.runNumber, period: r.period.name, employees: r.employeesCount, earnings: r.totalEarnings.toString(), deductions: r.totalDeductions.toString(), net: r.totalNet.toString(), status: r.status }));
    cols = [{ header: 'Run', key: 'run' }, { header: 'Period', key: 'period' }, { header: 'Employees', key: 'employees' }, { header: 'Earnings', key: 'earnings' }, { header: 'Deductions', key: 'deductions' }, { header: 'Net', key: 'net' }, { header: 'Status', key: 'status' }];
  } else throw notFound();
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'payroll.export')) throw forbidden('PERMISSION_DENIED');
    return exporter.send(res, q.format, { title: `Payroll — ${t}`, filename: `payroll-${t}`, columns: cols, rows: items });
  }
  res.json(exporter.table(cols, items));
}));

module.exports = router;
