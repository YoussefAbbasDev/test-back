// Default configuration for a newly created company: roles, system salary components, policies, workflows.
// Values are starting templates the company can edit — not legal rules.
const { ALL_PERMISSIONS, ROLE_TEMPLATES } = require('../config/permissions');

const ensurePermissions = async (tx) => {
  const existing = await tx.permission.findMany({ select: { code: true } });
  const have = new Set(existing.map((p) => p.code));
  const missing = ALL_PERMISSIONS.filter((c) => !have.has(c));
  if (missing.length) await tx.permission.createMany({ data: missing.map((code) => { const [module, action] = code.split('.'); return { code, module, action }; }) });
  return tx.permission.findMany();
};

const SYSTEM_COMPONENTS = [
  ['BASIC', 'الراتب الأساسي', 'Basic Salary', 'EARNING', 'BASIC', 'EMPLOYEE_AMOUNT', { includeInOvertimeBase: true, includeInEosBase: true, includeInGosiBase: true, includeInAbsenceBase: true }, 1],
  ['HOUSING', 'بدل السكن', 'Housing Allowance', 'EARNING', 'HOUSING', 'EMPLOYEE_AMOUNT', { includeInEosBase: true, includeInGosiBase: true, includeInAbsenceBase: true }, 2],
  ['TRANSPORT', 'بدل النقل', 'Transportation Allowance', 'EARNING', 'TRANSPORT', 'EMPLOYEE_AMOUNT', { includeInAbsenceBase: true }, 3],
  ['OTHER_ALLOW', 'بدلات ثابتة أخرى', 'Other Fixed Allowances', 'EARNING', 'ALLOWANCE', 'EMPLOYEE_AMOUNT', {}, 4],
  ['OVERTIME', 'العمل الإضافي', 'Overtime', 'EARNING', 'OVERTIME', 'SYSTEM', { prorate: false }, 10],
  ['COMMISSION', 'العمولات', 'Commissions', 'EARNING', 'COMMISSION', 'SYSTEM', { prorate: false }, 11],
  ['BONUS', 'المكافآت', 'Bonuses', 'EARNING', 'BONUS', 'SYSTEM', { prorate: false }, 12],
  ['OTHER_EARN', 'استحقاقات أخرى', 'Other Earnings', 'EARNING', 'OTHER_EARNING', 'SYSTEM', { prorate: false }, 13],
  ['ABSENCE', 'خصم الغياب', 'Absence Deduction', 'DEDUCTION', 'ABSENCE', 'SYSTEM', { prorate: false }, 20],
  ['LATE', 'خصم التأخير', 'Late Deduction', 'DEDUCTION', 'LATE', 'SYSTEM', { prorate: false }, 21],
  ['EARLY_LEAVE', 'خصم الانصراف المبكر', 'Early Leave Deduction', 'DEDUCTION', 'EARLY_LEAVE', 'SYSTEM', { prorate: false }, 22],
  ['UNPAID_LEAVE', 'خصم إجازة غير مدفوعة', 'Unpaid Leave Deduction', 'DEDUCTION', 'UNPAID_LEAVE', 'SYSTEM', { prorate: false }, 23],
  ['GOSI', 'التأمينات الاجتماعية', 'GOSI (Employee Share)', 'DEDUCTION', 'GOSI', 'SYSTEM', { prorate: false }, 24],
  ['PENALTY', 'جزاءات معتمدة', 'Approved Penalties', 'DEDUCTION', 'PENALTY', 'SYSTEM', { prorate: false }, 25],
  ['OTHER_DED', 'استقطاعات أخرى', 'Other Deductions', 'DEDUCTION', 'OTHER_DEDUCTION', 'SYSTEM', { prorate: false }, 26],
  ['ADVANCE', 'استرداد سلفة', 'Advance Repayment', 'DEDUCTION', 'ADVANCE', 'SYSTEM', { prorate: false }, 27],
  ['LOAN', 'قسط قرض', 'Loan Installment', 'DEDUCTION', 'LOAN', 'SYSTEM', { prorate: false }, 28],
];

const provisionCompany = async (tx, company) => {
  const perms = await ensurePermissions(tx);
  const permId = new Map(perms.map((p) => [p.code, p.id]));
  const roles = {};
  for (const t of ROLE_TEMPLATES) {
    const role = await tx.role.create({ data: { companyId: company.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, dataScope: t.dataScope, isSystem: true } });
    await tx.rolePermission.createMany({ data: [...new Set(t.permissions)].filter((c) => permId.has(c)).map((c) => ({ roleId: role.id, permissionId: permId.get(c) })) });
    roles[t.code] = role;
  }
  await tx.salaryComponent.createMany({
    data: SYSTEM_COMPONENTS.map(([code, nameAr, nameEn, type, category, calculationMethod, flags, sortOrder]) => ({ companyId: company.id, code, nameAr, nameEn, type, category, calculationMethod, isSystem: true, sortOrder, ...flags })),
  });
  await tx.payrollSetting.create({ data: { companyId: company.id } });
  await tx.attendancePolicy.create({ data: { companyId: company.id, name: 'Default policy', scope: 'COMPANY', isDefault: true, allowedMethods: ['GPS', 'QR', 'KIOSK', 'MANUAL', 'BIOMETRIC', 'NFC'] } });

  const wf = async (code, name, entityType, steps, extra = {}) => {
    const w = await tx.approvalWorkflow.create({ data: { companyId: company.id, code, name, entityType, isDefault: !extra.conditions, priority: extra.priority || 0, conditions: extra.conditions } });
    await tx.approvalStep.createMany({ data: steps.map((s, i) => ({ workflowId: w.id, stepOrder: i + 1, mode: 'ANY', ...s })) });
    return w;
  };
  const mgr = { name: 'Direct Manager', approverType: 'DIRECT_MANAGER', pendingStatus: 'PENDING_MANAGER' };
  const hr = { name: 'HR', approverType: 'ROLE', roleCode: 'HR_MANAGER', pendingStatus: 'PENDING_HR' };
  const fin = { name: 'Finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER', pendingStatus: 'PENDING_FINANCE' };
  const gm = { name: 'Authorized Manager', approverType: 'ROLE', roleCode: 'GENERAL_MANAGER', pendingStatus: 'PENDING_FINAL' };
  await wf('LEAVE_DEFAULT', 'Leave approval', 'LEAVE', [mgr, hr]);
  await wf('LEAVE_CANCEL_DEFAULT', 'Leave cancellation', 'LEAVE_CANCELLATION', [mgr, hr]);
  await wf('CORRECTION_DEFAULT', 'Attendance correction', 'ATTENDANCE_CORRECTION', [mgr, { ...hr, condition: null }]);
  await wf('SHIFT_EXCHANGE_DEFAULT', 'Shift exchange', 'SHIFT_EXCHANGE', [mgr]);
  await wf('ADVANCE_SMALL', 'Advance (< 5,000)', 'ADVANCE', [mgr], { conditions: { maxAmount: 4999.99 }, priority: 10 });
  await wf('ADVANCE_DEFAULT', 'Advance', 'ADVANCE', [mgr, hr, fin]);
  await wf('LOAN_DEFAULT', 'Loan', 'LOAN', [mgr, hr, fin, gm]);
  await wf('PAYROLL_DEFAULT', 'Payroll run', 'PAYROLL', [{ ...hr, name: 'HR Review', pendingStatus: 'IN_REVIEW' }, { ...fin, name: 'Finance Review', pendingStatus: 'IN_REVIEW' }, { ...gm, pendingStatus: 'IN_REVIEW' }]);
  await wf('SALARY_CHANGE_DEFAULT', 'Salary change', 'SALARY_CHANGE', [hr, fin]);
  return { roles };
};

module.exports = { provisionCompany, ensurePermissions, SYSTEM_COMPONENTS };
