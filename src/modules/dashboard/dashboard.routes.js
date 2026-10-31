// Global HRMS dashboard — every number comes from the database, filtered by the caller's scope.
const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { authorize, hasPermission } = require('../../middleware/auth');
const { toDateOnly, fmtDate, dayjs, localDate, eachDay } = require('../../utils/dates');
const { D, sum } = require('../../utils/money');
const { employeeWhere } = require('../../services/scope');

router.get('/', authorize('dashboard.view'), ah(async (req, res) => {
  const ctx = req.ctx;
  const q = req.query;
  const today = localDate(new Date(), ctx.tz);
  const from = toDateOnly(q.from || dayjs(today).subtract(29, 'day').toDate());
  const to = toDateOnly(q.to || today);
  const filters = [{ deletedAt: null }];
  if (q.branchId) filters.push({ branchId: q.branchId });
  if (q.departmentId) filters.push({ departmentId: q.departmentId });
  if (q.employeeId) filters.push({ id: q.employeeId });
  if (q.status) filters.push({ status: q.status });
  const empWhere = { AND: [await employeeWhere(ctx, 'dashboard.view'), ...filters] };
  const activeWhere = { AND: [empWhere, { status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] } }] };
  const in30 = toDateOnly(dayjs(today).add(ctx.company.contractAlertDays || 60, 'day').toDate());
  const docIn = toDateOnly(dayjs(today).add(ctx.company.documentAlertDays || 30, 'day').toDate());

  const [total, active, statusGroups, todayRecords, onLeaveToday, pendingLeaves, contractsExpiring, docsExpiring, pendingAdvances, pendingLoans, pendingCorrections, deptGroups, branchGroups] = await Promise.all([
    prisma.employee.count({ where: empWhere }),
    prisma.employee.count({ where: activeWhere }),
    prisma.employee.groupBy({ by: ['status'], where: empWhere, _count: true }),
    prisma.attendanceRecord.groupBy({ by: ['status'], where: { companyId: ctx.companyId, date: today, employee: empWhere }, _count: true }),
    prisma.leaveRequest.count({ where: { companyId: ctx.companyId, status: 'APPROVED', startDate: { lte: today }, endDate: { gte: today }, employee: empWhere } }),
    prisma.leaveRequest.count({ where: { companyId: ctx.companyId, status: { in: ['SUBMITTED', 'PENDING_MANAGER', 'PENDING_HR', 'CANCELLATION_PENDING'] }, employee: empWhere } }),
    prisma.employee.count({ where: { AND: [activeWhere, { contractEnd: { gte: today, lte: in30 } }] } }),
    prisma.employeeDocument.count({ where: { companyId: ctx.companyId, deletedAt: null, expiryDate: { lte: docIn }, employee: activeWhere } }),
    prisma.employeeAdvance.count({ where: { companyId: ctx.companyId, status: 'PENDING', employee: empWhere } }),
    prisma.employeeLoan.count({ where: { companyId: ctx.companyId, status: 'PENDING', employee: empWhere } }),
    prisma.attendanceCorrection.count({ where: { companyId: ctx.companyId, status: 'PENDING', employee: empWhere } }),
    prisma.employee.groupBy({ by: ['departmentId'], where: activeWhere, _count: true }),
    prisma.employee.groupBy({ by: ['branchId'], where: activeWhere, _count: true }),
  ]);
  const t = Object.fromEntries(todayRecords.map((r) => [r.status, r._count]));
  const [departments, branches] = await Promise.all([
    prisma.department.findMany({ where: { companyId: ctx.companyId }, select: { id: true, nameAr: true, nameEn: true } }),
    prisma.branch.findMany({ where: { companyId: ctx.companyId }, select: { id: true, nameAr: true, nameEn: true } }),
  ]);
  const nameOf = (list, id) => { const x = list.find((l) => l.id === id); return x ? { en: x.nameEn, ar: x.nameAr } : { en: '—', ar: '—' }; };

  // attendance trend & absence rate
  const trendRows = await prisma.attendanceRecord.groupBy({ by: ['date', 'status'], where: { companyId: ctx.companyId, date: { gte: from, lte: to }, employee: empWhere }, _count: true, _sum: { overtimeMinutes: true } });
  const attendanceTrend = eachDay(from, to).map((d) => {
    const rows = trendRows.filter((r) => fmtDate(r.date) === fmtDate(d));
    const get = (s) => rows.find((r) => r.status === s)?._count || 0;
    const present = get('PRESENT') + get('LATE') + get('HALF_DAY') + get('INCOMPLETE');
    const absent = get('ABSENT');
    return { date: fmtDate(d), present, late: get('LATE'), absent, onLeave: get('ON_LEAVE'), absenceRate: present + absent ? Math.round((absent / (present + absent)) * 1000) / 10 : 0, overtimeHours: Math.round((rows.reduce((s, r) => s + (r._sum.overtimeMinutes || 0), 0) / 60) * 10) / 10 };
  });

  // payroll / commissions — only when the caller may see payroll figures
  let payroll = null;
  if (hasPermission(ctx, 'payroll.view')) {
    const since = toDateOnly(dayjs(today).subtract(11, 'month').startOf('month').toDate());
    const runs = await prisma.payrollRun.findMany({ where: { companyId: ctx.companyId, type: { in: ['REGULAR', 'OFF_CYCLE', 'REVERSAL'] }, status: { in: ['LOCKED', 'PAID', 'PARTIALLY_PAID', 'APPROVED', 'CALCULATED', 'IN_REVIEW'] }, period: { startDate: { gte: since } } }, include: { period: true } });
    const byMonth = new Map();
    for (const r of runs) {
      const k = dayjs(r.period.startDate).format('YYYY-MM');
      byMonth.set(k, D(byMonth.get(k) || 0).plus(r.totalNet));
    }
    const monthKey = dayjs(today).format('YYYY-MM');
    const latestRunIds = runs.filter((r) => dayjs(r.period.startDate).format('YYYY-MM') === monthKey && ['LOCKED', 'PAID', 'PARTIALLY_PAID', 'APPROVED', 'CALCULATED', 'IN_REVIEW'].includes(r.status)).map((r) => r.id);
    const lastRun = runs.filter((r) => r.type === 'REGULAR').sort((a, b) => b.period.startDate - a.period.startDate)[0];
    const deptCost = lastRun ? await prisma.payrollRunEmployee.findMany({ where: { runId: lastRun.id, status: 'INCLUDED' }, select: { grossEarnings: true, snapshot: true } }) : [];
    const costMap = new Map();
    for (const r of deptCost) {
      const key = r.snapshot.departmentEn || '—';
      const cur = costMap.get(key) || { en: key, ar: r.snapshot.departmentAr || key, amount: D(0) };
      cur.amount = cur.amount.plus(r.grossEarnings);
      costMap.set(key, cur);
    }
    payroll = {
      thisMonth: sum(runs.filter((r) => latestRunIds.includes(r.id)), (r) => r.totalNet).toFixed(2),
      byMonth: [...byMonth.entries()].sort().map(([month, net]) => ({ month, net: Number(net.toFixed(2)) })),
      costByDepartment: [...costMap.values()].map((x) => ({ name: { en: x.en, ar: x.ar }, amount: Number(x.amount.toFixed(2)) })),
      pendingApprovals: await prisma.payrollRun.count({ where: { companyId: ctx.companyId, status: 'IN_REVIEW' } }),
    };
  }
  let commissions = null;
  if (hasPermission(ctx, 'commissions.view')) {
    const rows = await prisma.commissionTransaction.findMany({ where: { companyId: ctx.companyId, employee: empWhere, earnedDate: { gte: toDateOnly(dayjs(today).startOf('year').toDate()) }, status: { notIn: ['CANCELLED', 'REVERSED'] } }, include: { rule: { select: { nameEn: true, nameAr: true, type: true } } } });
    const byRule = new Map();
    for (const r of rows) {
      const k = r.rule?.nameEn || 'Manual';
      byRule.set(k, { en: k, ar: r.rule?.nameAr || 'يدوي', amount: D(byRule.get(k)?.amount || 0).plus(r.netAmount) });
    }
    commissions = {
      total: sum(rows, (r) => r.netAmount).toFixed(2),
      pending: sum(rows.filter((r) => ['CALCULATED', 'PENDING_APPROVAL', 'ON_HOLD'].includes(r.status)), (r) => r.netAmount).toFixed(2),
      distribution: [...byRule.values()].map((x) => ({ ...x, amount: Number(x.amount.toFixed(2)) })),
    };
  }

  // leave utilization (current year, annual leave)
  const year = dayjs(today).year();
  const balances = await prisma.leaveBalance.findMany({ where: { companyId: ctx.companyId, year, employee: activeWhere }, include: { leaveType: { select: { nameEn: true, nameAr: true } } } });
  const util = new Map();
  for (const b of balances) {
    const k = b.leaveType.nameEn;
    const acc = util.get(k) || { en: k, ar: b.leaveType.nameAr, entitled: D(0), used: D(0) };
    acc.entitled = acc.entitled.plus(b.openingBalance).plus(b.accrued).plus(b.carriedForward).plus(b.adjustments);
    acc.used = acc.used.plus(b.used);
    util.set(k, acc);
  }

  const pendingTasks = await prisma.approvalTask.count({ where: { approverUserId: ctx.userId, status: 'PENDING', instance: { companyId: ctx.companyId, status: 'PENDING' } } });

  res.json({
    kpis: {
      totalEmployees: total, activeEmployees: active, presentToday: (t.PRESENT || 0) + (t.LATE || 0) + (t.HALF_DAY || 0) + (t.INCOMPLETE || 0), absentToday: t.ABSENT || 0,
      lateToday: t.LATE || 0, onLeave: onLeaveToday, pendingLeaveRequests: pendingLeaves, payrollThisMonth: payroll?.thisMonth ?? null, totalCommissions: commissions?.total ?? null,
      pendingAdvances: pendingAdvances + pendingLoans, contractsExpiring, documentsExpiring: docsExpiring,
    },
    charts: {
      attendanceTrend,
      byDepartment: deptGroups.map((g) => ({ name: nameOf(departments, g.departmentId), count: g._count })).sort((a, b) => b.count - a.count),
      byBranch: branchGroups.map((g) => ({ name: nameOf(branches, g.branchId), count: g._count })),
      payrollByMonth: payroll?.byMonth ?? null,
      salaryCostByDepartment: payroll?.costByDepartment ?? null,
      commissionDistribution: commissions?.distribution ?? null,
      leaveUtilization: [...util.values()].map((u) => ({ en: u.en, ar: u.ar, entitled: Number(u.entitled.toFixed(1)), used: Number(u.used.toFixed(1)) })),
      statusDistribution: statusGroups.map((g) => ({ status: g.status, count: g._count })),
    },
    pending: {
      approvalsAssignedToMe: pendingTasks, leaveApprovals: pendingLeaves, attendanceCorrections: pendingCorrections, payrollApprovals: payroll?.pendingApprovals ?? 0,
      commissionApprovals: commissions ? await prisma.commissionTransaction.count({ where: { companyId: ctx.companyId, status: 'PENDING_APPROVAL', employee: empWhere } }) : 0,
      advanceRequests: pendingAdvances, loanRequests: pendingLoans, contractExpiry: contractsExpiring, documentExpiry: docsExpiring,
    },
    range: { from: fmtDate(from), to: fmtDate(to) },
  });
}));

module.exports = router;
