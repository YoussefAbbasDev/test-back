// Scheduled background jobs (node-cron). Each job is idempotent and runs per company in that company's timezone.
const cron = require('node-cron');
const prisma = require('../database/prisma');
const logger = require('../config/logger');
const { dayjs, toDateOnly, localDate, addDays, fmtDate } = require('../utils/dates');
const attendance = require('../modules/attendance/attendance.service');
const loans = require('../modules/loans/loans.service');
const { notify, usersWithRoles, userForEmployee } = require('../services/notifications');

const forEachCompany = async (fn) => {
  const companies = await prisma.company.findMany({ where: { deletedAt: null, status: 'ACTIVE' } });
  for (const c of companies) {
    try { await fn(c); } catch (e) { logger.error({ err: e, company: c.id }, 'job failed for company'); }
  }
};

// Yesterday's attendance: ABSENT / ON_LEAVE records and missing check-outs
const finalizeAttendance = () => forEachCompany(async (c) => {
  const yesterday = addDays(localDate(new Date(), c.timezone), -1);
  const r = await attendance.finalizeDay(c.id, yesterday);
  logger.info({ company: c.code, ...r }, 'attendance finalized');
});

// Employee status ON_LEAVE while on approved leave, back to ACTIVE afterwards
const syncLeaveStatus = () => forEachCompany(async (c) => {
  const today = localDate(new Date(), c.timezone);
  const onLeave = await prisma.leaveRequest.findMany({ where: { companyId: c.id, status: 'APPROVED', startDate: { lte: today }, endDate: { gte: today } }, select: { employeeId: true } });
  const ids = onLeave.map((l) => l.employeeId);
  await prisma.employee.updateMany({ where: { companyId: c.id, id: { in: ids }, status: 'ACTIVE' }, data: { status: 'ON_LEAVE' } });
  await prisma.employee.updateMany({ where: { companyId: c.id, id: { notIn: ids }, status: 'ON_LEAVE' }, data: { status: 'ACTIVE' } });
});

// Document & contract expiry alerts (once per document per alert window)
const expiryAlerts = () => forEachCompany(async (c) => {
  const today = toDateOnly(new Date());
  const hr = await usersWithRoles(c.id, ['HR_MANAGER', 'HR_OFFICER']);
  const docs = await prisma.employeeDocument.findMany({ where: { companyId: c.id, deletedAt: null, expiryDate: { not: null, lte: toDateOnly(dayjs().add(365, 'day').toDate()) }, lastAlertAt: null }, include: { employee: true } });
  for (const d of docs) {
    const days = dayjs(d.expiryDate).diff(dayjs(today), 'day');
    const alertDays = d.alertDaysBefore ?? c.documentAlertDays;
    const status = days < 0 ? 'EXPIRED' : days <= alertDays ? 'EXPIRING' : 'VALID';
    if (status !== d.status) await prisma.employeeDocument.update({ where: { id: d.id }, data: { status } });
    if (status === 'VALID') continue;
    const self = await userForEmployee(d.employeeId);
    await notify({ companyId: c.id, userIds: [...hr, self], type: 'DOCUMENT_EXPIRING', params: { document: d.name, employee: `${d.employee.firstName} ${d.employee.lastName}`, date: fmtDate(d.expiryDate) }, link: `/employees/${d.employeeId}?tab=documents` });
    await prisma.employeeDocument.update({ where: { id: d.id }, data: { lastAlertAt: new Date() } });
  }
  const contracts = await prisma.employee.findMany({ where: { companyId: c.id, deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'ON_LEAVE'] }, contractEnd: { gte: today, lte: toDateOnly(dayjs().add(c.contractAlertDays, 'day').toDate()) } } });
  const weekly = dayjs().day() === c.workWeekStartsOn;
  if (weekly && contracts.length) {
    await notify({ companyId: c.id, userIds: hr, type: 'CONTRACT_EXPIRING', params: { count: contracts.length }, link: `/employees?contractExpiringDays=${c.contractAlertDays}` });
  }
});

const installmentJob = () => forEachCompany(async (c) => {
  await loans.refreshInstallmentStatuses(c.id);
  const due = await prisma.installment.findMany({ where: { companyId: c.id, status: 'DUE', dueDate: toDateOnly(dayjs().add(3, 'day').toDate()) } });
  for (const i of due) await notify({ companyId: c.id, userIds: [await userForEmployee(i.employeeId)], type: 'INSTALLMENT_DUE', params: { amount: i.amount.toString(), date: fmtDate(i.dueDate) }, link: '/advances' });
});

const start = () => {
  cron.schedule('15 0 * * *', finalizeAttendance, { timezone: 'UTC' });
  cron.schedule('5 0 * * *', syncLeaveStatus, { timezone: 'UTC' });
  cron.schedule('0 5 * * *', expiryAlerts, { timezone: 'UTC' });
  cron.schedule('30 1 * * *', installmentJob, { timezone: 'UTC' });
  logger.info('background jobs scheduled');
};

module.exports = { start, finalizeAttendance, syncLeaveStatus, expiryAlerts, installmentJob };
