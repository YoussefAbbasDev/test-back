const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, date, optDate, money, optMoney, nonNegativeMoney, listQuery } = require('../../utils/validate');
const { authorize, hasPermission } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { badRequest, forbidden, notFound } = require('../../utils/errors');
const { toDateOnly, fmtDate, dayjs } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const { parsePaging, paged } = require('../../utils/pagination');
const { employeeWhere } = require('../../services/scope');
const { empName } = require('../../services/common');
const exporter = require('../../services/exporter');
const engine = require('../../engines/commission');
const service = require('./commissions.service');

const TYPES = ['FIXED_PER_SERVICE', 'PERCENT_SALES', 'PERCENT_COLLECTED', 'PERCENT_NET_PROFIT', 'PER_TASK', 'TARGET', 'TIERED', 'TEAM', 'SUPERVISOR', 'BRANCH_MANAGER', 'MONTHLY_BONUS', 'PERFORMANCE_BONUS'];
const BASES = ['SALES_AMOUNT', 'COLLECTED_AMOUNT', 'NET_PROFIT', 'TASK_COUNT', 'FIXED'];
const settingsPerm = { view: 'commissions.view', create: 'commissions.settings', edit: 'commissions.settings', delete: 'commissions.settings' };

const ruleSchema = z.object({
  code: z.string().trim().min(1).max(40), nameAr: str(150), nameEn: str(150), type: z.enum(TYPES), calculationBase: z.enum(BASES), value: nonNegativeMoney.default('0'),
  tierMode: z.enum(['WHOLE_AMOUNT', 'INCREMENTAL']).nullable().optional(), minTarget: optMoney, maxTarget: optMoney, maxCommission: optMoney,
  employeeIds: z.array(z.string().uuid()).nullable().optional(), positionIds: z.array(z.string().uuid()).nullable().optional(), departmentIds: z.array(z.string().uuid()).nullable().optional(),
  branchIds: z.array(z.string().uuid()).nullable().optional(), serviceCategory: optStr(100), serviceCode: optStr(100),
  conditions: z.object({ requireCompleted: z.boolean().optional(), requireQuality: z.boolean().optional(), requireInvoice: z.boolean().optional(), requireCollection: z.boolean().optional(), excludeCancelled: z.boolean().optional(), excludeRefunded: z.boolean().optional(), requireActiveEmployee: z.boolean().optional() }).nullable().optional(),
  requiresApproval: z.boolean().optional(), participantRole: z.enum(['ANY', 'TECHNICIAN', 'SALES', 'SUPERVISOR', 'MANAGER']).optional(),
  effectiveFrom: date, expiryDate: optDate, priority: z.coerce.number().int().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  tiers: z.array(z.object({ fromAmount: nonNegativeMoney, toAmount: optMoney, rate: nonNegativeMoney })).max(20).optional(),
});

router.use('/rules', crudRouter({
  model: 'commissionRule', entity: 'CommissionRule', perm: settingsPerm, searchFields: ['code', 'nameAr', 'nameEn'], orderBy: { priority: 'desc' },
  include: { tiers: { orderBy: { fromAmount: 'asc' } } }, filters: { status: (v) => ({ status: v }), type: (v) => ({ type: v }) },
  createSchema: ruleSchema, updateSchema: ruleSchema.partial(),
  toData: async (b, ctx, mode, before) => {
    const { tiers, ...rest } = b;
    const type = b.type || before?.type;
    if (type === 'TIERED') {
      if (!(b.tierMode || before?.tierMode)) throw badRequest('TIER_MODE_REQUIRED');
      if (mode === 'create' && !tiers?.length) throw badRequest('TIERS_REQUIRED');
      if (tiers) engine.validateTiers(tiers);
    }
    for (const key of ['employeeIds', 'positionIds', 'departmentIds', 'branchIds']) {
      if (!b[key]?.length) continue;
      const model = { employeeIds: 'employee', positionIds: 'jobPosition', departmentIds: 'department', branchIds: 'branch' }[key];
      if ((await prisma[model].count({ where: { id: { in: b[key] }, companyId: ctx.companyId } })) !== new Set(b[key]).size) throw badRequest('INVALID_REFERENCE', { field: key });
    }
    return { ...rest, ...(b.effectiveFrom ? { effectiveFrom: toDateOnly(b.effectiveFrom) } : {}), ...('expiryDate' in b ? { expiryDate: b.expiryDate ? toDateOnly(b.expiryDate) : null } : {}) };
  },
  afterWrite: async (tx, row, ctx, body) => {
    if (body.tiers) {
      await tx.commissionTier.deleteMany({ where: { ruleId: row.id } });
      if (body.tiers.length) await tx.commissionTier.createMany({ data: body.tiers.map((t) => ({ ruleId: row.id, fromAmount: t.fromAmount, toAmount: t.toAmount ?? null, rate: t.rate })) });
    }
  },
  beforeDelete: async (row, ctx) => {
    if (await prisma.commissionTransaction.count({ where: { companyId: ctx.companyId, ruleId: row.id } })) throw require('../../utils/errors').conflict('RELATED_RECORDS_EXIST');
  },
}));

// Preview a tiered calculation (UI helper)
router.post('/rules/preview', authorize('commissions.view'), validate({ body: z.object({ amount: money, tierMode: z.enum(['WHOLE_AMOUNT', 'INCREMENTAL']), tiers: z.array(z.object({ fromAmount: money, toAmount: optMoney, rate: money })).min(1) }) }),
  ah(async (req, res) => res.json({ commission: engine.tieredAmount(req.body.amount, engine.validateTiers(req.body.tiers), req.body.tierMode).toFixed(2) })));

// Source transactions (from SEEDA ERP or manual entry)
const sourceSchema = z.object({
  externalRef: z.string().trim().min(1).max(120), sourceSystem: z.string().max(30).optional(), branchId: optId, transactionDate: date,
  serviceCategory: optStr(100), serviceCode: optStr(100), serviceName: optStr(200), salesAmount: nonNegativeMoney.default('0'), collectedAmount: nonNegativeMoney.default('0'),
  netProfit: money.default('0'), taskCount: z.coerce.number().int().min(0).default(1), isCompleted: z.boolean().default(true), qualityApproved: z.boolean().default(false),
  invoiceIssued: z.boolean().default(false), invoiceCollected: z.boolean().default(false), isCancelled: z.boolean().default(false), isRefunded: z.boolean().default(false),
  participants: z.array(z.object({ employeeId: z.string().uuid(), role: z.enum(['TECHNICIAN', 'SALES', 'SUPERVISOR', 'MANAGER']).default('TECHNICIAN'), sharePercent: nonNegativeMoney })).min(1).max(20),
});
router.get('/source-transactions', authorize('commissions.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = { companyId: req.ctx.companyId, ...(q.status ? { status: q.status } : {}), ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.search ? { OR: [{ externalRef: { contains: q.search } }, { serviceName: { contains: q.search } }] } : {}) };
  const paging = parsePaging(q);
  const [items, total] = await Promise.all([
    prisma.commissionSourceTransaction.findMany({ where, include: { participants: { include: { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } } } } }, orderBy: { transactionDate: 'desc' }, skip: paging.skip, take: paging.take }),
    prisma.commissionSourceTransaction.count({ where }),
  ]);
  res.json(paged(items, total, paging));
}));
router.post('/source-transactions', authorize('commissions.create'), validate({ body: sourceSchema }), ah(async (req, res) => res.status(201).json(await service.createSource(req.ctx, req.body))));
router.patch('/source-transactions/:id', authorize('commissions.edit'),
  validate({ body: z.object({ qualityApproved: z.boolean().optional(), invoiceIssued: z.boolean().optional(), invoiceCollected: z.boolean().optional(), isCancelled: z.boolean().optional(), isRefunded: z.boolean().optional(), collectedAmount: nonNegativeMoney.optional(), isCompleted: z.boolean().optional() }) }),
  ah(async (req, res) => res.json(await service.updateSourceFlags(req.ctx, req.params.id, req.body))));

router.post('/calculate', authorize('commissions.create'), validate({ body: z.object({ from: date, to: date, branchId: optId, ruleIds: z.array(z.string().uuid()).optional() }) }),
  ah(async (req, res) => res.json(await service.calculate(req.ctx, req.body))));

// Ledger
const ledgerWhere = async (ctx, q) => {
  const where = { companyId: ctx.companyId };
  if (q.mine === 'true') where.employeeId = ctx.employeeId || '-';
  else where.employee = await employeeWhere(ctx, 'commissions.view');
  if (q.status) where.status = { in: q.status.split(',') };
  if (q.employeeId) where.employeeId = q.employeeId;
  if (q.branchId) where.branchId = q.branchId;
  if (q.ruleId) where.ruleId = q.ruleId;
  if (q.from) where.earnedDate = { ...(where.earnedDate || {}), gte: toDateOnly(q.from) };
  if (q.to) where.earnedDate = { ...(where.earnedDate || {}), lte: toDateOnly(q.to) };
  return where;
};
const ledgerInclude = { employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } }, rule: { select: { code: true, nameAr: true, nameEn: true, type: true } } };
router.get('/', authorize('commissions.view'), validate({ query: listQuery }), ah(async (req, res) => {
  const q = req.validQuery;
  const where = await ledgerWhere(req.ctx, q);
  if (q.format && q.format !== 'json') {
    if (!hasPermission(req.ctx, 'commissions.export')) throw forbidden('PERMISSION_DENIED');
    const rows = await prisma.commissionTransaction.findMany({ where, include: ledgerInclude, orderBy: { earnedDate: 'desc' }, take: 50000 });
    return exporter.send(res, q.format, {
      title: 'Commission ledger', filename: 'commissions', rows,
      columns: [{ header: 'Date', value: (r) => fmtDate(r.earnedDate) }, { header: 'Employee', value: (r) => empName(r.employee) }, { header: 'Rule', value: (r) => r.rule?.code }, { header: 'Type', key: 'entryType' }, { header: 'Base', value: (r) => Number(r.calculationBase) }, { header: 'Rate', value: (r) => (r.rate ? Number(r.rate) : '') }, { header: 'Share %', value: (r) => Number(r.sharePercent) }, { header: 'Net', value: (r) => Number(r.netAmount) }, { header: 'Status', key: 'status' }],
    });
  }
  const paging = parsePaging(q, { defaultSize: 50 });
  const [items, total, totals] = await Promise.all([
    prisma.commissionTransaction.findMany({ where, include: ledgerInclude, orderBy: [{ earnedDate: 'desc' }, { createdAt: 'desc' }], skip: paging.skip, take: paging.take }),
    prisma.commissionTransaction.count({ where }),
    prisma.commissionTransaction.groupBy({ by: ['status'], where, _sum: { netAmount: true } }),
  ]);
  res.json({ ...paged(items, total, paging), totals: Object.fromEntries(totals.map((t) => [t.status, D(t._sum.netAmount).toFixed(2)])) });
}));

router.post('/manual', authorize('commissions.create'), validate({ body: z.object({ employeeId: z.string().uuid(), amount: money, reason: str(500), ruleId: optId, earnedDate: optDate }) }), ah(async (req, res) => res.status(201).json(await service.manualEntry(req.ctx, req.body))));

const actionBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), reason: optStr(500) });
const ACTIONS = { approve: ['commissions.approve', 'APPROVED'], reject: ['commissions.reject', 'CANCELLED'], hold: ['commissions.approve', 'ON_HOLD'], release: ['commissions.approve', 'APPROVED'], payable: ['commissions.approve', 'PAYABLE'] };
for (const [name, [perm, to]] of Object.entries(ACTIONS)) {
  router.post(`/bulk/${name}`, authorize(perm), validate({ body: actionBody }), ah(async (req, res) => res.json(await service.bulkTransition(req.ctx, req.body.ids, to, { reason: req.body.reason }))));
  router.post(`/:id/${name}`, authorize(perm), validate({ body: z.object({ reason: optStr(500) }) }), ah(async (req, res) => res.json(await service.transition(req.ctx, req.params.id, to, { reason: req.body.reason }))));
}
router.post('/:id/reverse', authorize('commissions.approve'), validate({ body: z.object({ reason: str(500) }) }), ah(async (req, res) => res.json(await service.reverse(req.ctx, req.params.id, req.body.reason))));

router.get('/dashboard', authorize('commissions.view'), ah(async (req, res) => {
  const ctx = req.ctx;
  const from = toDateOnly(req.query.from || dayjs().subtract(5, 'month').startOf('month').toDate());
  const to = toDateOnly(req.query.to || new Date());
  const where = { companyId: ctx.companyId, employee: await employeeWhere(ctx, 'commissions.view'), earnedDate: { gte: from, lte: to }, status: { notIn: ['CANCELLED', 'REVERSED'] } };
  const rows = await prisma.commissionTransaction.findMany({ where, include: { employee: { select: { id: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, branch: { select: { nameAr: true, nameEn: true } } } }, rule: { select: { nameEn: true, nameAr: true } } } });
  const byStatus = (s) => sum(rows.filter((r) => s.includes(r.status)), (r) => r.netAmount).toFixed(2);
  const group = (key, label) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r) || '-';
      const acc = m.get(k) || { key: k, label: label(r), amount: D(0) };
      acc.amount = acc.amount.plus(r.netAmount);
      m.set(k, acc);
    }
    return [...m.values()].sort((a, b) => b.amount.comparedTo(a.amount)).map((x) => ({ ...x, amount: x.amount.toFixed(2) }));
  };
  res.json({
    total: sum(rows, (r) => r.netAmount).toFixed(2), pending: byStatus(['CALCULATED', 'PENDING_APPROVAL', 'ON_HOLD']), approved: byStatus(['APPROVED', 'PAYABLE']), paid: byStatus(['PAID', 'INCLUDED_IN_PAYROLL']),
    ranking: group((r) => r.employeeId, (r) => ({ en: empName(r.employee), ar: r.employee.fullNameAr || empName(r.employee) })).slice(0, 10),
    byBranch: group((r) => r.employee.branch?.nameEn, (r) => ({ en: r.employee.branch?.nameEn, ar: r.employee.branch?.nameAr })),
    byService: group((r) => r.serviceCode || r.rule?.nameEn, (r) => ({ en: r.serviceCode || r.rule?.nameEn, ar: r.serviceCode || r.rule?.nameAr })),
    trend: group((r) => dayjs(r.earnedDate).format('YYYY-MM'), (r) => dayjs(r.earnedDate).format('YYYY-MM')).sort((a, b) => a.key.localeCompare(b.key)),
  });
}));

module.exports = router;
