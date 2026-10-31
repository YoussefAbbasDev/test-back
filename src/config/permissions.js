// Permission catalog and default role templates.
// A permission code is "<module>.<action>". Every API route declares the code it requires.

const MODULES = [
  'dashboard', 'employees', 'organization', 'attendance', 'shifts', 'leaves', 'payroll', 'payslips',
  'commissions', 'advances', 'loans', 'reports', 'settings', 'users', 'audit',
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'reject', 'export', 'print', 'settings'];
// Extra fine-grained actions
const EXTRA = ['employees.financial', 'employees.documents', 'attendance.manual', 'attendance.review'];

const ALL_PERMISSIONS = [
  ...MODULES.flatMap((m) => ACTIONS.map((a) => `${m}.${a}`)),
  ...EXTRA,
];

const SCOPE_RANK = { OWN: 1, ASSIGNED: 2, TEAM: 3, DEPARTMENT: 4, BRANCH: 5, COMPANY: 6 };
const SCOPES = Object.keys(SCOPE_RANK);

const all = (mod) => ACTIONS.map((a) => `${mod}.${a}`);
const pick = (mod, ...actions) => actions.map((a) => `${mod}.${a}`);
const readOnly = (mod) => pick(mod, 'view', 'export', 'print');

const ROLE_TEMPLATES = [
  {
    code: 'COMPANY_OWNER', nameEn: 'Company Owner', nameAr: 'مالك الشركة', dataScope: 'COMPANY',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'GENERAL_MANAGER', nameEn: 'General Manager', nameAr: 'المدير العام', dataScope: 'COMPANY',
    permissions: [
      ...MODULES.flatMap((m) => pick(m, 'view', 'approve', 'reject', 'export', 'print')),
      'employees.financial', 'employees.documents', 'attendance.review',
    ],
  },
  {
    code: 'HR_MANAGER', nameEn: 'HR Manager', nameAr: 'مدير الموارد البشرية', dataScope: 'COMPANY',
    permissions: [
      'dashboard.view', ...all('employees'), ...all('organization'), ...all('attendance'), ...all('shifts'), ...all('leaves'),
      ...pick('payroll', 'view', 'create', 'edit', 'approve', 'reject', 'export', 'print'), ...readOnly('payslips'),
      ...pick('commissions', 'view', 'export'), ...pick('advances', 'view', 'approve', 'reject', 'export', 'print'),
      ...pick('loans', 'view', 'approve', 'reject', 'export', 'print'), ...readOnly('reports'),
      ...pick('settings', 'view', 'edit', 'settings'), ...pick('users', 'view', 'create', 'edit'), 'audit.view',
      'employees.financial', 'employees.documents', 'attendance.manual', 'attendance.review',
    ],
  },
  {
    code: 'HR_OFFICER', nameEn: 'HR Officer', nameAr: 'أخصائي موارد بشرية', dataScope: 'COMPANY',
    permissions: [
      'dashboard.view', ...pick('employees', 'view', 'create', 'edit', 'export', 'print'), ...pick('organization', 'view'),
      ...pick('attendance', 'view', 'create', 'edit', 'export', 'print'), ...pick('shifts', 'view', 'create', 'edit', 'export'),
      ...pick('leaves', 'view', 'create', 'edit', 'export', 'print'), ...readOnly('reports'),
      ...pick('advances', 'view'), ...pick('loans', 'view'), 'employees.documents', 'attendance.manual',
    ],
  },
  {
    code: 'PAYROLL_MANAGER', nameEn: 'Payroll Manager', nameAr: 'مدير الرواتب', dataScope: 'COMPANY',
    permissions: [
      'dashboard.view', ...all('payroll'), ...all('payslips'), 'employees.view', 'employees.financial', 'employees.export',
      ...readOnly('attendance'), ...readOnly('leaves'), ...pick('commissions', 'view', 'create', 'edit', 'export', 'settings'),
      ...pick('advances', 'view', 'export'), ...pick('loans', 'view', 'export'), ...readOnly('reports'), 'organization.view',
    ],
  },
  {
    code: 'FINANCE_MANAGER', nameEn: 'Finance Manager', nameAr: 'المدير المالي', dataScope: 'COMPANY',
    permissions: [
      'dashboard.view', ...pick('payroll', 'view', 'approve', 'reject', 'export', 'print'), ...readOnly('payslips'),
      ...pick('commissions', 'view', 'approve', 'reject', 'export'), ...pick('advances', 'view', 'approve', 'reject', 'export', 'print', 'edit'),
      ...pick('loans', 'view', 'approve', 'reject', 'export', 'print', 'edit'), ...readOnly('reports'), 'employees.view', 'organization.view',
    ],
  },
  {
    code: 'BRANCH_MANAGER', nameEn: 'Branch Manager', nameAr: 'مدير الفرع', dataScope: 'BRANCH',
    permissions: [
      'dashboard.view', ...readOnly('employees'), 'organization.view', ...pick('attendance', 'view', 'create', 'approve', 'reject', 'export', 'print'),
      'attendance.review', ...all('shifts'), ...pick('leaves', 'view', 'approve', 'reject', 'export'),
      ...pick('commissions', 'view', 'export'), ...readOnly('reports'), ...pick('advances', 'view'), ...pick('loans', 'view'),
    ],
  },
  {
    code: 'DEPARTMENT_MANAGER', nameEn: 'Department Manager', nameAr: 'مدير الإدارة', dataScope: 'DEPARTMENT',
    permissions: [
      'dashboard.view', ...readOnly('employees'), 'organization.view', ...pick('attendance', 'view', 'approve', 'reject', 'export'),
      ...pick('shifts', 'view', 'create', 'edit', 'export'), ...pick('leaves', 'view', 'approve', 'reject', 'export'),
      ...readOnly('reports'), ...pick('commissions', 'view'),
    ],
  },
  {
    code: 'SUPERVISOR', nameEn: 'Supervisor', nameAr: 'مشرف', dataScope: 'ASSIGNED',
    permissions: [
      'dashboard.view', 'employees.view', 'organization.view', ...pick('attendance', 'view', 'approve', 'reject'),
      ...pick('shifts', 'view', 'create', 'edit'), ...pick('leaves', 'view', 'approve', 'reject'), 'commissions.view',
    ],
  },
  {
    code: 'EMPLOYEE', nameEn: 'Employee', nameAr: 'موظف', dataScope: 'OWN',
    permissions: [
      'employees.view', 'organization.view', 'attendance.view', 'attendance.create', 'shifts.view', 'shifts.create',
      'leaves.view', 'leaves.create', 'payslips.view', 'payslips.print', 'commissions.view',
      'advances.view', 'advances.create', 'loans.view', 'loans.create',
    ],
  },
];

module.exports = { MODULES, ACTIONS, ALL_PERMISSIONS, SCOPE_RANK, SCOPES, ROLE_TEMPLATES };
