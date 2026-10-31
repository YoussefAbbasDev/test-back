// Central notification service. In-app notifications are stored; external channels go to an outbound queue and are
// only delivered when a provider is configured (see integrations/messaging.js). Nothing is reported as "sent" otherwise.
const prisma = require('../database/prisma');
const logger = require('../config/logger');

const TYPES = [
  'EMPLOYEE_LATE', 'EMPLOYEE_ABSENT', 'MISSING_CHECKOUT', 'LEAVE_REQUESTED', 'LEAVE_APPROVED', 'LEAVE_REJECTED',
  'LEAVE_CANCELLED', 'APPROVAL_REQUIRED', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'PAYROLL_APPROVED', 'PAYSLIP_GENERATED',
  'COMMISSION_APPROVED', 'ADVANCE_APPROVED', 'LOAN_APPROVED', 'INSTALLMENT_DUE', 'CONTRACT_EXPIRING', 'DOCUMENT_EXPIRING',
  'SHIFT_CHANGED', 'SHIFT_EXCHANGE_REQUESTED', 'CORRECTION_APPROVED', 'CORRECTION_REJECTED',
];

/**
 * notify({ companyId, userIds, type, params, link }, tx?)
 * Respects per-user preferences (default: in-app on, other channels off).
 */
const notify = async ({ companyId, userIds, type, params = {}, link = null }, tx = prisma) => {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  try {
    const prefs = await tx.notificationPreference.findMany({ where: { userId: { in: ids }, type } });
    const prefBy = new Map(prefs.map((p) => [p.userId, p]));
    const inApp = ids.filter((id) => prefBy.get(id)?.inApp !== false);
    if (inApp.length) {
      await tx.notification.createMany({ data: inApp.map((userId) => ({ companyId, userId, type, params, link })) });
    }
    const emailUsers = ids.filter((id) => prefBy.get(id)?.email);
    if (emailUsers.length) {
      const users = await tx.user.findMany({ where: { id: { in: emailUsers } }, select: { email: true } });
      await tx.outboundMessage.createMany({
        data: users.map((u) => ({
          companyId, channel: 'EMAIL', recipient: u.email, subject: type, body: JSON.stringify({ type, params, link }),
          status: process.env.SMTP_URL ? 'QUEUED' : 'NOT_CONFIGURED',
        })),
      });
    }
  } catch (e) {
    if (tx !== prisma) throw e;
    logger.error({ err: e }, 'notification failed');
  }
};

// Users holding any of the given role codes in a company (used for HR/Finance notifications)
const usersWithRoles = async (companyId, roleCodes, tx = prisma) => {
  const rows = await tx.userRole.findMany({
    where: { role: { companyId, code: { in: roleCodes } }, user: { status: 'ACTIVE', deletedAt: null } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
};

const userForEmployee = async (employeeId, tx = prisma) => {
  if (!employeeId) return null;
  const u = await tx.user.findFirst({ where: { employeeId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  return u?.id || null;
};

module.exports = { notify, usersWithRoles, userForEmployee, TYPES };
