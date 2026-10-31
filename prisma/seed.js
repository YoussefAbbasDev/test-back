/* eslint-disable no-console */
// SEEDA HRMS demo seed. Creates "SEEDA Demo Company" (isDemo = true) and drives the real services
// (approvals, attendance recompute, commissions, payroll) so the demo data is produced by the same business logic.
// Refuses to run in production. Demo credentials are written to backend/.demo-credentials.md (git-ignored).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
process.env.LOG_LEVEL = 'error';

const prisma = require('../src/database/prisma');
const { provisionCompany, ensurePermissions } = require('../src/services/provision');
const { loadContext } = require('../src/middleware/auth');
const { toDateOnly, eachDay, weekday, localTimeToUtc, fmtDate, dayjs } = require('../src/utils/dates');
const attendance = require('../src/modules/attendance/attendance.service');
const leaves = require('../src/modules/leaves/leaves.service');
const shifts = require('../src/modules/shifts/shifts.service');
const commissions = require('../src/modules/commissions/commissions.service');
const loans = require('../src/modules/loans/loans.service');
const payroll = require('../src/modules/payroll/payroll.service');
const approvals = require('../src/services/approvals');

// deterministic PRNG so every seed produces the same demo
let state = 20261031;
const rand = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const TODAY = toDateOnly(process.env.SEED_TODAY || new Date());
const PASSWORD = process.env.DEMO_PASSWORD || `Seeda-${crypto.randomBytes(4).toString('hex')}-26`;

const fakeReq = { get: () => null, ip: '127.0.0.1' };
const ctxFor = async (userId) => loadContext(userId, fakeReq);
const approveAll = async (entityType, entityId, users) => {
  for (let guard = 0; guard < 10; guard++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'PENDING', instance: { entityType, entityId, status: 'PENDING' } } });
    if (!task) return;
    await approvals.act(await ctxFor(task.approverUserId), task.id, 'APPROVE', 'Approved (demo)');
  }
};

const main = async () => {
  const existing = await prisma.company.findUnique({ where: { code: 'SEEDA-DEMO' } });
  if (existing) {
    console.log('Demo company already exists. Run `npm run db:reset` to recreate the database from scratch.');
    return;
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  await ensurePermissions(prisma);

  // ── Platform super admin ──
  await prisma.user.create({ data: { email: 'superadmin@seeda.demo', displayName: 'SEEDA Super Admin', passwordHash: hash, isSuperAdmin: true, language: 'en' } });

  // ── Company ──
  const company = await prisma.company.create({ data: { code: 'SEEDA-DEMO', nameAr: 'شركة سيدا التجريبية', nameEn: 'SEEDA Demo Company', currency: 'SAR', timezone: 'Asia/Riyadh', country: 'SA', weekendDays: [5, 6], isDemo: true } });
  const { roles } = await prisma.$transaction((tx) => provisionCompany(tx, company), { timeout: 60000 });
  const C = company.id;

  // demo payroll configuration (company-editable; not legal advice)
  await prisma.payrollSetting.update({ where: { companyId: C }, data: { maxDeductionPercent: '50', gosiEmployeeRate: '9.75', gosiEmployerRate: '11.75', gosiNationalities: ['Saudi'], lateDeductionMode: 'PER_MINUTE', lateFreeMinutesPerPeriod: 60 } });
  await prisma.systemSetting.createMany({ data: [{ companyId: C, key: 'scheduling.maxWeeklyHours', value: 48 }, { companyId: C, key: 'advances.maxAmount', value: 20000 }, { companyId: C, key: 'attendance.qrTtlSeconds', value: 60 }] });

  // ── Branches & geofences ──
  const branchData = [
    ['RUH', 'الرياض', 'Riyadh', 'Riyadh', 24.7136, 46.6753],
    ['JED', 'جدة', 'Jeddah', 'Jeddah', 21.5433, 39.1728],
    ['DMM', 'الدمام', 'Dammam', 'Dammam', 26.4207, 50.0888],
  ];
  const B = {};
  for (const [code, nameAr, nameEn, city, lat, lng] of branchData) {
    B[code] = await prisma.branch.create({ data: { companyId: C, code, nameAr: `فرع ${nameAr}`, nameEn: `${nameEn} Branch`, city, latitude: lat, longitude: lng, address: `${city}, Saudi Arabia` } });
    await prisma.attendanceLocation.create({ data: { companyId: C, branchId: B[code].id, name: `${nameEn} Branch`, latitude: lat, longitude: lng, radiusMeters: 200 } });
  }

  // ── Organization ──
  const dep = async (code, nameAr, nameEn, type = 'DEPARTMENT', parentId = null, sortOrder = 0) => prisma.department.create({ data: { companyId: C, code, nameAr, nameEn, type, parentId, sortOrder } });
  const D = {};
  D.MGT = await dep('MGT', 'الإدارة العليا', 'Management', 'EXECUTIVE', null, 0);
  D.HR = await dep('HR', 'الموارد البشرية', 'Human Resources', 'DEPARTMENT', D.MGT.id, 1);
  D.FIN = await dep('FIN', 'المالية', 'Finance', 'DEPARTMENT', D.MGT.id, 2);
  D.SAL = await dep('SAL', 'المبيعات', 'Sales', 'DEPARTMENT', D.MGT.id, 3);
  D.OPS = await dep('OPS', 'العمليات', 'Operations', 'DEPARTMENT', D.MGT.id, 4);
  D.TEC = await dep('TEC', 'القسم الفني', 'Technical Department', 'DEPARTMENT', D.MGT.id, 5);
  D.CS = await dep('OPS-CS', 'خدمة العملاء', 'Customer Service', 'SECTION', D.OPS.id, 6);
  D.DET = await dep('TEC-DET', 'العناية والتلميع', 'Detailing & Care', 'SECTION', D.TEC.id, 7);

  const grades = {};
  for (const [code, name, level, min, max] of [['G1', 'Grade 1', 1, 3000, 5000], ['G2', 'Grade 2', 2, 5000, 8000], ['G3', 'Grade 3', 3, 8000, 14000], ['G4', 'Grade 4', 4, 14000, 22000], ['G5', 'Grade 5', 5, 22000, 40000]]) {
    grades[code] = await prisma.jobGrade.create({ data: { companyId: C, code, name, level, minSalary: String(min), maxSalary: String(max) } });
  }
  const pos = async (code, titleAr, titleEn, d, g, level) => prisma.jobPosition.create({ data: { companyId: C, code, titleAr, titleEn, departmentId: d.id, gradeId: grades[g].id, level } });
  const P = {
    GM: await pos('GM', 'المدير العام', 'General Manager', D.MGT, 'G5', 5),
    HRM: await pos('HRM', 'مدير الموارد البشرية', 'HR Manager', D.HR, 'G4', 4),
    HRO: await pos('HRO', 'أخصائي موارد بشرية', 'HR Officer', D.HR, 'G2', 2),
    FM: await pos('FM', 'المدير المالي', 'Finance Manager', D.FIN, 'G4', 4),
    ACC: await pos('ACC', 'محاسب', 'Accountant', D.FIN, 'G3', 3),
    BM: await pos('BM', 'مدير فرع', 'Branch Manager', D.OPS, 'G4', 4),
    SUP: await pos('SUP', 'مشرف', 'Supervisor', D.TEC, 'G3', 3),
    TECH: await pos('TECH', 'فني', 'Technician', D.DET, 'G1', 1),
    SR: await pos('SR', 'مندوب مبيعات', 'Sales Representative', D.SAL, 'G2', 2),
    CSA: await pos('CSA', 'خدمة عملاء', 'Customer Service', D.CS, 'G1', 1),
  };

  // ── Shifts ──
  const shift = (code, nameAr, nameEn, startTime, endTime, breakMinutes, expectedMinutes, color, type = 'FIXED') => prisma.shift.create({ data: { companyId: C, code, nameAr, nameEn, startTime, endTime, breakMinutes, expectedMinutes, workingDays: [0, 1, 2, 3, 4], color, type, crossesMidnight: endTime <= startTime } });
  const S = {
    MOR: await shift('MOR', 'الوردية الصباحية', 'Morning Shift', '08:00', '17:00', 60, 480, '#5A4293'),
    EVE: await shift('EVE', 'الوردية المسائية', 'Evening Shift', '14:00', '23:00', 60, 480, '#2D3D62'),
    NGT: await shift('NGT', 'الوردية الليلية', 'Night Shift', '22:00', '06:00', 60, 420, '#8B7BB8', 'NIGHT'),
  };
  for (const b of Object.values(B)) {
    await prisma.shiftCoverageRequirement.create({ data: { companyId: C, branchId: b.id, shiftId: S.MOR.id, minEmployees: 4 } });
    await prisma.shiftCoverageRequirement.create({ data: { companyId: C, branchId: b.id, shiftId: S.EVE.id, minEmployees: 2 } });
  }

  // ── Employees ──
  const comps = Object.fromEntries((await prisma.salaryComponent.findMany({ where: { companyId: C } })).map((c) => [c.code, c]));
  const people = [
    // key, first, last, ar, gender, nationality, position, dept, branch, manager, basic, hire, roles, email
    ['gm', 'Faisal', 'Al-Harbi', 'فيصل الحربي', 'MALE', 'Saudi', 'GM', 'MGT', 'RUH', null, 30000, '2018-01-07', ['GENERAL_MANAGER'], 'gm@seeda.demo'],
    ['hrm', 'Noura', 'Al-Qahtani', 'نورة القحطاني', 'FEMALE', 'Saudi', 'HRM', 'HR', 'RUH', 'gm', 18000, '2019-03-03', ['HR_MANAGER'], 'hr.manager@seeda.demo'],
    ['hro', 'Sara', 'Al-Otaibi', 'سارة العتيبي', 'FEMALE', 'Saudi', 'HRO', 'HR', 'RUH', 'hrm', 7500, '2021-06-13', ['HR_OFFICER'], 'hr.officer@seeda.demo'],
    ['fm', 'Khalid', 'Al-Mutairi', 'خالد المطيري', 'MALE', 'Saudi', 'FM', 'FIN', 'RUH', 'gm', 19000, '2019-09-01', ['FINANCE_MANAGER'], 'finance@seeda.demo'],
    ['pm', 'Ahmed', 'Hassan', 'أحمد حسن', 'MALE', 'Egyptian', 'ACC', 'FIN', 'RUH', 'fm', 11000, '2020-02-02', ['PAYROLL_MANAGER'], 'payroll@seeda.demo'],
    ['bmr', 'Omar', 'Al-Shehri', 'عمر الشهري', 'MALE', 'Saudi', 'BM', 'OPS', 'RUH', 'gm', 15000, '2019-11-10', ['BRANCH_MANAGER'], 'riyadh.manager@seeda.demo'],
    ['bmj', 'Yousef', 'Al-Ghamdi', 'يوسف الغامدي', 'MALE', 'Saudi', 'BM', 'OPS', 'JED', 'gm', 14500, '2020-05-17', ['BRANCH_MANAGER'], 'jeddah.manager@seeda.demo'],
    ['bmd', 'Majed', 'Al-Dossari', 'ماجد الدوسري', 'MALE', 'Saudi', 'BM', 'OPS', 'DMM', 'gm', 14500, '2021-01-03', ['BRANCH_MANAGER'], 'dammam.manager@seeda.demo'],
    ['supr', 'Mohammed', 'Iqbal', 'محمد إقبال', 'MALE', 'Pakistani', 'SUP', 'TEC', 'RUH', 'bmr', 8500, '2020-08-09', ['SUPERVISOR'], 'supervisor.riyadh@seeda.demo'],
    ['supj', 'Rami', 'Saleh', 'رامي صالح', 'MALE', 'Jordanian', 'SUP', 'TEC', 'JED', 'bmj', 8200, '2021-04-04', ['SUPERVISOR'], 'supervisor.jeddah@seeda.demo'],
    ['t1', 'Raj', 'Kumar', 'راج كومار', 'MALE', 'Indian', 'TECH', 'DET', 'RUH', 'supr', 3800, '2022-02-06', [], 'emp0011@seeda.demo'],
    ['t2', 'Ali', 'Raza', 'علي رضا', 'MALE', 'Pakistani', 'TECH', 'DET', 'RUH', 'supr', 3600, '2022-07-03', [], 'emp0012@seeda.demo'],
    ['t3', 'Juan', 'Dela Cruz', 'خوان ديلا كروز', 'MALE', 'Filipino', 'TECH', 'DET', 'RUH', 'supr', 3700, '2023-01-15', [], 'emp0013@seeda.demo'],
    ['t4', 'Hassan', 'Mahmoud', 'حسن محمود', 'MALE', 'Egyptian', 'TECH', 'DET', 'JED', 'supj', 3900, '2021-10-10', [], 'emp0014@seeda.demo'],
    ['t5', 'Bilal', 'Ahmed', 'بلال أحمد', 'MALE', 'Pakistani', 'TECH', 'DET', 'JED', 'supj', 3500, '2023-05-21', [], 'emp0015@seeda.demo'],
    ['t6', 'Samir', 'Khan', 'سمير خان', 'MALE', 'Indian', 'TECH', 'DET', 'DMM', 'bmd', 3600, '2022-09-11', [], 'emp0016@seeda.demo'],
    ['s1', 'Abdullah', 'Al-Zahrani', 'عبدالله الزهراني', 'MALE', 'Saudi', 'SR', 'SAL', 'RUH', 'bmr', 6500, '2022-03-20', [], 'emp0017@seeda.demo'],
    ['s2', 'Lama', 'Al-Harthi', 'لمى الحارثي', 'FEMALE', 'Saudi', 'SR', 'SAL', 'JED', 'bmj', 6200, '2023-02-12', [], 'emp0018@seeda.demo'],
    ['s3', 'Turki', 'Al-Anazi', 'تركي العنزي', 'MALE', 'Saudi', 'SR', 'SAL', 'DMM', 'bmd', 6000, '2023-08-06', [], 'emp0019@seeda.demo'],
    ['c1', 'Hind', 'Al-Shammari', 'هند الشمري', 'FEMALE', 'Saudi', 'CSA', 'CS', 'RUH', 'bmr', 5500, '2022-11-13', [], 'emp0020@seeda.demo'],
    ['c2', 'Maha', 'Al-Juhani', 'مها الجهني', 'FEMALE', 'Saudi', 'CSA', 'CS', 'JED', 'bmj', 5400, '2024-01-07', [], 'emp0021@seeda.demo'],
    ['acc', 'Tariq', 'Nasser', 'طارق ناصر', 'MALE', 'Jordanian', 'ACC', 'FIN', 'RUH', 'fm', 9000, '2021-12-05', [], 'emp0022@seeda.demo'],
    ['c3', 'Fatimah', 'Al-Ali', 'فاطمة العلي', 'FEMALE', 'Saudi', 'CSA', 'CS', 'DMM', 'bmd', 5300, '2024-06-02', [], 'emp0023@seeda.demo'],
    ['t7', 'Kevin', 'Santos', 'كيفن سانتوس', 'MALE', 'Filipino', 'TECH', 'DET', 'RUH', 'supr', 3500, '2026-10-01', [], 'emp0024@seeda.demo'],
  ];
  const E = {};
  const U = {};
  let n = 0;
  for (const [key, first, last, ar, gender, nationality, posKey, depKey, brKey, mgrKey, basic, hire, roleCodes, email] of people) {
    n++;
    const p = P[posKey];
    const d = D[depKey];
    const isSection = d.type === 'SECTION';
    const emp = await prisma.employee.create({
      data: {
        companyId: C, employeeNumber: `EMP-${String(n).padStart(4, '0')}`, firstName: first, lastName: last, fullNameEn: `${first} ${last}`, fullNameAr: ar, gender, nationality,
        maritalStatus: pick(['SINGLE', 'MARRIED']), dateOfBirth: toDateOnly(`${1980 + Math.floor(rand() * 18)}-0${1 + Math.floor(rand() * 8)}-1${Math.floor(rand() * 9)}`),
        nationalId: `${nationality === 'Saudi' ? '1' : '2'}${String(100000000 + Math.floor(rand() * 899999999))}`, mobile: `+9665${String(10000000 + Math.floor(rand() * 89999999))}`,
        email, country: 'Saudi Arabia', city: B[brKey].city, branchId: B[brKey].id, departmentId: isSection ? d.parentId : d.id, sectionId: isSection ? d.id : null,
        positionId: p.id, gradeId: p.gradeId, managerId: mgrKey ? E[mgrKey].id : null, hireDate: toDateOnly(hire),
        probationStart: toDateOnly(hire), probationEnd: toDateOnly(dayjs(hire).add(90, 'day').toDate()), contractStart: toDateOnly(hire),
        contractEnd: key === 's3' ? toDateOnly(dayjs(TODAY).add(40, 'day').toDate()) : nationality === 'Saudi' ? null : toDateOnly(dayjs(TODAY).add(200 + Math.floor(rand() * 400), 'day').toDate()),
        contractType: nationality === 'Saudi' ? 'UNLIMITED' : 'LIMITED', employmentType: 'FULL_TIME', noticePeriodDays: 30, defaultShiftId: S.MOR.id,
        status: dayjs(hire).add(90, 'day').isAfter(dayjs(TODAY)) ? 'PROBATION' : 'ACTIVE', paymentMethod: 'BANK', bankName: pick(['Al Rajhi Bank', 'Saudi National Bank', 'Riyad Bank']),
        iban: null, accountHolder: `${first} ${last}`, gosiApplicable: nationality === 'Saudi', kioskPinHash: await bcrypt.hash('1234', 6),
      },
    });
    // valid SA IBAN built with the mod-97 check digits
    const bban = `80${String(Math.floor(rand() * 1e9)).padStart(9, '0')}${String(n).padStart(9, '0')}`;
    const numeric = `${bban}SA00`.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
    let rem = 0;
    for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
    const iban = `SA${String(98 - rem).padStart(2, '0')}${bban}`;
    await prisma.employee.update({ where: { id: emp.id }, data: { iban } });
    E[key] = emp;
    await prisma.employeeEmergencyContact.create({ data: { companyId: C, employeeId: emp.id, name: `${pick(['Fahad', 'Aisha', 'Mona', 'Saeed'])} ${last}`, relationship: pick(['Spouse', 'Brother', 'Father', 'Sister']), phone: `+9665${String(10000000 + Math.floor(rand() * 89999999))}` } });
    await prisma.employeeEmploymentHistory.create({ data: { companyId: C, employeeId: emp.id, changeType: 'HIRE', field: 'hireDate', newValue: hire, effectiveDate: toDateOnly(hire) } });
    // salary: basic + housing 25% + transport 10%
    await prisma.employeeSalaryRevision.create({
      data: {
        companyId: C, employeeId: emp.id, effectiveFrom: toDateOnly(hire), reason: 'Initial salary', status: 'ACTIVE',
        lines: { create: [{ componentId: comps.BASIC.id, amount: String(basic) }, { componentId: comps.HOUSING.id, amount: String(basic * 0.25) }, { componentId: comps.TRANSPORT.id, amount: String(Math.round(basic * 0.1)) }] },
      },
    });
    const user = await prisma.user.create({
      data: {
        companyId: C, employeeId: emp.id, email, displayName: `${first} ${last}`, passwordHash: hash, language: nationality === 'Saudi' ? 'ar' : 'en',
        roles: { create: [...new Set(['EMPLOYEE', ...roleCodes])].map((code) => ({ roleId: roles[code].id })) },
      },
    });
    U[key] = user;
  }
  // company owner (no employee profile)
  const owner = await prisma.user.create({ data: { companyId: C, email: 'owner@seeda.demo', displayName: 'Company Owner', passwordHash: hash, language: 'ar', roles: { create: [{ roleId: roles.COMPANY_OWNER.id }] } } });

  // managers of units
  await prisma.branch.update({ where: { id: B.RUH.id }, data: { managerId: E.bmr.id } });
  await prisma.branch.update({ where: { id: B.JED.id }, data: { managerId: E.bmj.id } });
  await prisma.branch.update({ where: { id: B.DMM.id }, data: { managerId: E.bmd.id } });
  for (const [k, m] of [['MGT', 'gm'], ['HR', 'hrm'], ['FIN', 'fm'], ['SAL', 'bmr'], ['OPS', 'bmr'], ['TEC', 'supr'], ['CS', 'bmr'], ['DET', 'supr']]) await prisma.department.update({ where: { id: D[k].id }, data: { managerId: E[m].id } });
  const teamA = await prisma.team.create({ data: { companyId: C, departmentId: D.DET.id, code: 'DET-RUH-A', nameAr: 'فريق التلميع - الرياض', nameEn: 'Detailing Team Riyadh', leaderId: E.supr.id } });
  await prisma.employee.updateMany({ where: { id: { in: [E.t1.id, E.t2.id, E.t3.id, E.t7.id] } }, data: { teamId: teamA.id } });

  // mid-period raise for proration demo
  await prisma.employeeSalaryRevision.create({
    data: { companyId: C, employeeId: E.t1.id, effectiveFrom: toDateOnly('2026-10-15'), reason: 'Performance raise', status: 'ACTIVE', lines: { create: [{ componentId: comps.BASIC.id, amount: '4300' }, { componentId: comps.HOUSING.id, amount: '1075' }, { componentId: comps.TRANSPORT.id, amount: '430' }] } },
  });

  // documents
  for (const k of ['t1', 't4', 'pm', 'supr']) {
    await prisma.employeeDocument.create({ data: { companyId: C, employeeId: E[k].id, type: 'IQAMA', name: 'Iqama', number: `2${String(Math.floor(rand() * 1e9))}`, issueDate: toDateOnly('2025-01-01'), expiryDate: toDateOnly(dayjs(TODAY).add(k === 't1' ? 12 : 200, 'day').toDate()), status: k === 't1' ? 'EXPIRING' : 'VALID' } });
    await prisma.employeeDocument.create({ data: { companyId: C, employeeId: E[k].id, type: 'PASSPORT', name: 'Passport', number: `P${String(Math.floor(rand() * 1e7))}`, expiryDate: toDateOnly(dayjs(TODAY).add(k === 't4' ? -5 : 900, 'day').toDate()), status: k === 't4' ? 'EXPIRED' : 'VALID' } });
  }

  // ── Leave types & policies (demo configuration; adjust to the company's contracts and local law) ──
  const lt = async (code, nameAr, nameEn, category, isPaid, color, policy) => {
    const t = await prisma.leaveType.create({ data: { companyId: C, code, nameAr, nameEn, category, isPaid, payPercent: isPaid ? '100' : '0', color } });
    await prisma.leavePolicy.create({ data: { companyId: C, leaveTypeId: t.id, name: `${nameEn} policy`, effectiveFrom: toDateOnly('2018-01-01'), ...policy } });
    return t;
  };
  const LT = {
    AL: await lt('AL', 'إجازة سنوية', 'Annual Leave', 'ANNUAL', true, '#5A4293', { annualEntitlement: '21', accrualMethod: 'UPFRONT', carryForwardMax: '10', minRequestDays: '1', maxRequestDays: '30' }),
    SL: await lt('SL', 'إجازة مرضية', 'Sick Leave', 'SICK', true, '#E25C5C', { annualEntitlement: '30', accrualMethod: 'UPFRONT', attachmentRequired: true, attachmentAfterDays: '1', prorateFirstYear: false }),
    EL: await lt('EL', 'إجازة طارئة', 'Emergency Leave', 'EMERGENCY', true, '#F2A93B', { annualEntitlement: '5', accrualMethod: 'UPFRONT', maxRequestDays: '3' }),
    ML: await lt('MRL', 'إجازة زواج', 'Marriage Leave', 'MARRIAGE', true, '#4CAF7A', { annualEntitlement: '5', accrualMethod: 'UPFRONT', prorateFirstYear: false }),
    BL: await lt('BRL', 'إجازة وفاة', 'Bereavement Leave', 'BEREAVEMENT', true, '#6B7280', { annualEntitlement: '5', accrualMethod: 'UPFRONT', prorateFirstYear: false }),
    MAT: await lt('MAT', 'إجازة وضع', 'Maternity Leave', 'MATERNITY', true, '#D86BB0', { annualEntitlement: '70', accrualMethod: 'UPFRONT', genderRestriction: 'FEMALE', countWeekends: true, prorateFirstYear: false }),
    PAT: await lt('PAT', 'إجازة أبوة', 'Paternity Leave', 'PATERNITY', true, '#3B82F6', { annualEntitlement: '3', accrualMethod: 'UPFRONT', genderRestriction: 'MALE', prorateFirstYear: false }),
    UL: await lt('UL', 'إجازة بدون راتب', 'Unpaid Leave', 'UNPAID', false, '#9CA3AF', { annualEntitlement: '0', accrualMethod: 'NONE', requiresBalance: false, reserveOnPending: false }),
  };
  for (const [date, ar, en] of [['2026-02-22', 'يوم التأسيس', 'Founding Day'], ['2026-09-23', 'اليوم الوطني', 'National Day'], ['2026-03-20', 'عيد الفطر', 'Eid Al-Fitr'], ['2026-05-27', 'عيد الأضحى', 'Eid Al-Adha']]) {
    await prisma.holiday.create({ data: { companyId: C, date: toDateOnly(date), nameAr: ar, nameEn: en } });
  }

  // ── Shift schedule: this week + next week (Riyadh: technicians split morning/evening) ──
  const ctxHR = await ctxFor(U.hrm.id);
  const weekStart = dayjs(TODAY).startOf('week');
  const from = fmtDate(weekStart.toDate());
  const to = fmtDate(weekStart.add(13, 'day').toDate());
  const riyadh = ['bmr', 'supr', 't1', 't3', 't7', 's1', 'c1'].map((k) => E[k].id);
  await shifts.assign(ctxHR, { employeeIds: riyadh, shiftId: S.MOR.id, from, to });
  await shifts.assign(ctxHR, { employeeIds: [E.t2.id], shiftId: S.EVE.id, from, to });
  await shifts.assign(ctxHR, { employeeIds: ['bmj', 'supj', 't4', 's2', 'c2'].map((k) => E[k].id), shiftId: S.MOR.id, from, to });
  await shifts.assign(ctxHR, { employeeIds: [E.t5.id], shiftId: S.NGT.id, from, to });
  await shifts.assign(ctxHR, { employeeIds: ['bmd', 't6', 's3', 'c3'].map((k) => E[k].id), shiftId: S.MOR.id, from, to });

  // ── Leaves (through the real request + approval flow) ──
  const ctxOf = async (k) => ctxFor(U[k].id);
  const leave = async (k, type, startDate, endDate, approve = true, reason = 'Personal') => {
    const r = await leaves.create(await ctxOf(k), { leaveTypeId: LT[type].id, startDate, endDate, reason });
    if (approve) await approveAll('LEAVE', r.id);
    return r;
  };
  await leave('t2', 'AL', '2026-09-13', '2026-09-17');
  await leave('s1', 'AL', '2026-10-11', '2026-10-15');
  await leave('t5', 'UL', '2026-09-20', '2026-09-22', true, 'Family matter');
  await leave('c1', 'EL', '2026-10-06', '2026-10-06');
  await leave('t3', 'AL', '2026-11-08', '2026-11-12', false, 'Travel');
  await leave('hro', 'AL', '2026-11-15', '2026-11-19', false, 'Vacation');

  // ── Attendance history (Sep 1 → yesterday): events + recompute through the attendance engine ──
  console.log('Generating attendance…');
  const yesterday = dayjs(TODAY).subtract(1, 'day').toDate();
  const allEmps = await prisma.employee.findMany({ where: { companyId: C } });
  const approvedLeaves = await prisma.leaveRequest.findMany({ where: { companyId: C, status: 'APPROVED' } });
  const holidays = new Set((await prisma.holiday.findMany({ where: { companyId: C } })).map((h) => fmtDate(h.date)));
  for (const day of eachDay('2026-09-01', yesterday)) {
    if ([5, 6].includes(weekday(day)) || holidays.has(fmtDate(day))) continue;
    for (const emp of allEmps) {
      if (emp.hireDate > day) continue;
      if (approvedLeaves.some((l) => l.employeeId === emp.id && l.startDate <= day && l.endDate >= day)) continue;
      const r = rand();
      if (r < 0.03) continue; // absent (finalize creates ABSENT)
      const late = r < 0.15 ? 12 + Math.floor(rand() * 35) : Math.floor(rand() * 8) - 5;
      const isNight = emp.id === E.t5.id && day >= toDateOnly(from);
      const startHHMM = isNight ? '22:00' : emp.id === E.t2.id && day >= toDateOnly(from) ? '14:00' : '08:00';
      const inAt = dayjs(localTimeToUtc(day, startHHMM, company.timezone)).add(late, 'minute').toDate();
      const overtime = rand() < 0.12 ? 45 + Math.floor(rand() * 90) : 0;
      const missingOut = rand() < 0.015;
      const outAt = dayjs(inAt).add(9 * 60 - late + overtime + Math.floor(rand() * 10) - (rand() < 0.05 ? 50 : 0), 'minute').toDate();
      const branchLoc = await prisma.attendanceLocation.findFirst({ where: { branchId: emp.branchId } });
      const record = await prisma.attendanceRecord.create({ data: { companyId: C, employeeId: emp.id, date: toDateOnly(day), status: 'INCOMPLETE' } });
      const ev = [{ type: 'CHECK_IN', occurredAt: inAt }];
      if (!missingOut) ev.push({ type: 'BREAK_START', occurredAt: dayjs(inAt).add(4 * 60, 'minute').toDate() }, { type: 'BREAK_END', occurredAt: dayjs(inAt).add(5 * 60, 'minute').toDate() }, { type: 'CHECK_OUT', occurredAt: outAt });
      await prisma.attendanceEvent.createMany({
        data: ev.map((e) => ({ companyId: C, employeeId: emp.id, recordId: record.id, type: e.type, occurredAt: e.occurredAt, method: pick(['GPS', 'GPS', 'QR', 'KIOSK']), latitude: branchLoc ? Number(branchLoc.latitude) + (rand() - 0.5) * 0.001 : null, longitude: branchLoc ? Number(branchLoc.longitude) + (rand() - 0.5) * 0.001 : null, accuracy: 8 + Math.floor(rand() * 20), locationId: branchLoc?.id })),
      });
      await prisma.$transaction((tx) => attendance.recompute(tx, record.id));
    }
    if (day < toDateOnly(yesterday) || fmtDate(day) === fmtDate(yesterday)) await attendance.finalizeDay(C, day);
  }
  // approve most overtime (manager decision) — leave a few pending for the demo
  const otPending = await prisma.attendanceRecord.findMany({ where: { companyId: C, overtimeStatus: 'PENDING' }, include: { employee: true } });
  for (const rec of otPending) {
    if (rec.date >= toDateOnly('2026-10-25')) continue;
    // HR manager approves (the GM approves HR manager's own overtime — no self-approval)
    const approver = rec.employeeId === E.hrm.id ? U.gm : U.hrm;
    await attendance.decideOvertime(await ctxFor(approver.id), rec.id, { approve: true });
  }
  // a pending attendance correction
  await attendance.requestCorrection(await ctxOf('t3'), { date: fmtDate(dayjs(TODAY).subtract(2, 'day').startOf('day').toDate()), checkIn: '07:58', reason: 'Forgot to punch with the app; badge photo attached' }).catch(() => {});

  // ── Commissions ──
  console.log('Generating commissions…');
  const rule = (data, tiers) => prisma.commissionRule.create({ data: { companyId: C, effectiveFrom: toDateOnly('2026-01-01'), ...data, ...(tiers ? { tiers: { create: tiers } } : {}) } });
  await rule({ code: 'TECH-5', nameAr: 'عمولة الفنيين 5%', nameEn: 'Technician 5% of sales', type: 'PERCENT_SALES', calculationBase: 'SALES_AMOUNT', value: '5', participantRole: 'TECHNICIAN', requiresApproval: true, conditions: { requireCompleted: true, requireQuality: true, excludeCancelled: true, excludeRefunded: true } });
  await rule({ code: 'SUP-2', nameAr: 'عمولة المشرف 2%', nameEn: 'Supervisor 2% of sales', type: 'SUPERVISOR', calculationBase: 'SALES_AMOUNT', value: '2', participantRole: 'SUPERVISOR', requiresApproval: true });
  await rule({ code: 'SALES-TIER', nameAr: 'شرائح المبيعات الشهرية', nameEn: 'Monthly sales tiers', type: 'TIERED', calculationBase: 'COLLECTED_AMOUNT', value: '0', tierMode: 'INCREMENTAL', participantRole: 'SALES', requiresApproval: true, conditions: { requireCollection: true } },
    [{ fromAmount: '0', toAmount: '10000', rate: '2' }, { fromAmount: '10000', toAmount: '20000', rate: '3' }, { fromAmount: '20000', toAmount: null, rate: '5' }]);
  await rule({ code: 'BM-1', nameAr: 'حافز مدير الفرع', nameEn: 'Branch manager incentive', type: 'BRANCH_MANAGER', calculationBase: 'SALES_AMOUNT', value: '1', minTarget: '20000', requiresApproval: true });
  const services = [['CC-WASH', 'Premium wash', 350], ['CC-POLISH', 'Polish & wax', 900], ['CC-CERAMIC', 'Ceramic coating', 2800], ['CC-PPF', 'Paint protection film', 5200], ['CC-INT', 'Interior detailing', 650]];
  const teams = { RUH: { tech: ['t1', 't2', 't3'], sup: 'supr', sales: 's1' }, JED: { tech: ['t4', 't5'], sup: 'supj', sales: 's2' }, DMM: { tech: ['t6'], sup: null, sales: 's3' } };
  let ref = 1000;
  const ctxPM = await ctxFor(U.pm.id);
  for (const day of eachDay('2026-09-01', yesterday)) {
    if ([5].includes(weekday(day))) continue;
    for (const [br, t] of Object.entries(teams)) {
      if (rand() < 0.45) continue;
      const [code, name, price] = pick(services);
      const techs = [pick(t.tech), ...(rand() < 0.3 && t.tech.length > 1 ? [t.tech[0]] : [])].filter((v, i, a) => a.indexOf(v) === i);
      const participants = [];
      const techShare = t.sup ? 80 : 100;
      techs.forEach((k, i) => participants.push({ employeeId: E[k].id, role: 'TECHNICIAN', sharePercent: String(i === 0 ? techShare - (techs.length - 1) * 30 : 30) }));
      if (t.sup) participants.push({ employeeId: E[t.sup].id, role: 'SUPERVISOR', sharePercent: '20' });
      // sales rep is a separate participant set → separate transaction line for the sales tier rule
      const amount = price * (1 + Math.floor(rand() * 2));
      const collected = rand() < 0.9;
      await commissions.createSource(ctxPM, {
        externalRef: `JOB-${br}-${ref++}`, sourceSystem: 'SEEDA_ERP_DEMO', branchId: B[br].id, transactionDate: fmtDate(day), serviceCategory: 'CAR_CARE', serviceCode: code, serviceName: name,
        salesAmount: String(amount), collectedAmount: String(collected ? amount : 0), netProfit: String(Math.round(amount * 0.4)), taskCount: 1, isCompleted: true,
        qualityApproved: rand() < 0.92, invoiceIssued: true, invoiceCollected: collected, participants,
      });
      await commissions.createSource(ctxPM, {
        externalRef: `SALE-${br}-${ref++}`, sourceSystem: 'SEEDA_ERP_DEMO', branchId: B[br].id, transactionDate: fmtDate(day), serviceCategory: 'CAR_CARE', serviceCode: code, serviceName: name,
        salesAmount: String(amount), collectedAmount: String(collected ? amount : 0), netProfit: String(Math.round(amount * 0.4)), taskCount: 1, isCompleted: true, qualityApproved: true, invoiceIssued: true, invoiceCollected: collected,
        participants: [{ employeeId: E[t.sales].id, role: 'SALES', sharePercent: '100' }],
      });
    }
  }
  await commissions.calculate(ctxPM, { from: '2026-09-01', to: '2026-09-30' });
  await commissions.calculate(ctxPM, { from: '2026-10-01', to: fmtDate(yesterday) });
  const ctxFM = await ctxFor(U.fm.id);
  const sept = await prisma.commissionTransaction.findMany({ where: { companyId: C, earnedDate: { lte: toDateOnly('2026-09-30') }, status: 'PENDING_APPROVAL' } });
  await commissions.bulkTransition(ctxFM, sept.map((s) => s.id), 'APPROVED');

  // ── Advances & loans ──
  const adv = await loans.create(await ctxOf('t4'), 'advance', { amount: '3000', reason: 'Family expenses', installmentCount: 3, firstDeductionDate: '2026-09-27', repaymentMethod: 'PAYROLL' });
  await approveAll('ADVANCE', adv.id);
  await loans.disburse(ctxFM, 'advance', adv.id, { note: 'Bank transfer (demo)' });
  const loan = await loans.create(await ctxOf('hro'), 'loan', { amount: '12000', loanType: 'PERSONAL', reason: 'Car purchase', installmentCount: 12, firstDeductionDate: '2026-09-27', repaymentMethod: 'PAYROLL' });
  await approveAll('LOAN', loan.id);
  await loans.disburse(ctxFM, 'loan', loan.id, { note: 'Bank transfer (demo)' });
  await loans.create(await ctxOf('t6'), 'advance', { amount: '1500', reason: 'Rent', installmentCount: 2, repaymentMethod: 'PAYROLL' });
  await loans.create(await ctxOf('s2'), 'advance', { amount: '8000', reason: 'Medical expenses', installmentCount: 6, repaymentMethod: 'PAYROLL' });

  // ── Payroll: September run approved, locked and paid; October run calculated ──
  console.log('Running payroll…');
  await prisma.payrollAdjustment.create({ data: { companyId: C, employeeId: E.s1.id, type: 'EARNING', category: 'BONUS', amount: '1000', effectiveDate: toDateOnly('2026-09-30'), reason: 'Top seller Q3', status: 'APPROVED', createdById: U.pm.id, approvedById: U.fm.id } });
  const sep = await payroll.createPeriod(ctxPM, { name: 'September 2026', startDate: '2026-09-01', endDate: '2026-09-30', paymentDate: '2026-09-27' });
  const run = await payroll.createRun(ctxPM, { periodId: sep.id });
  await payroll.calculate(ctxPM, run.id);
  await payroll.submit(ctxPM, run.id);
  await approveAll('PAYROLL', run.id);
  await payroll.lock(ctxPM, run.id);
  await payroll.recordPayments(ctxFM, run.id, { reference: 'SNB-BATCH-0926', paidAt: '2026-09-27T09:00:00Z' });
  await prisma.commissionTransaction.updateMany({ where: { companyId: C, status: 'PENDING_APPROVAL', earnedDate: { lte: toDateOnly('2026-10-20') }, ruleId: { not: null } }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: U.fm.id } });
  const oct = await payroll.createPeriod(ctxPM, { name: 'October 2026', startDate: '2026-10-01', endDate: '2026-10-31', paymentDate: '2026-10-27' });
  const run2 = await payroll.createRun(ctxPM, { periodId: oct.id });
  await payroll.calculate(ctxPM, run2.id);

  // ── Kiosk device (key written to credentials file) ──
  const { sha256, randomToken } = require('../src/utils/crypto');
  const kioskKey = `sdk_${randomToken(32)}`;
  await prisma.attendanceDevice.create({ data: { companyId: C, branchId: B.RUH.id, type: 'KIOSK', name: 'Riyadh lobby kiosk', apiKeyHash: sha256(kioskKey), apiKeyPrefix: kioskKey.slice(0, 10) } });

  const lines = [
    '# SEEDA HRMS — demo credentials (development only, git-ignored)', '',
    `Generated: ${new Date().toISOString()}`, '', `All demo accounts share the password: \`${PASSWORD}\``, '',
    '| Account | Role |', '|---|---|',
    '| owner@seeda.demo | Company Owner |', '| gm@seeda.demo | General Manager |', '| hr.manager@seeda.demo | HR Manager |', '| hr.officer@seeda.demo | HR Officer |',
    '| finance@seeda.demo | Finance Manager |', '| payroll@seeda.demo | Payroll Manager |', '| riyadh.manager@seeda.demo | Branch Manager (Riyadh) |',
    '| supervisor.riyadh@seeda.demo | Supervisor |', '| emp0011@seeda.demo … emp0024@seeda.demo | Employees |', '| superadmin@seeda.demo | Platform Super Admin |', '',
    `Kiosk device key (Riyadh): \`${kioskKey}\` — open /kiosk in the app and paste it. Employee kiosk PIN for every demo employee: 1234.`,
  ];
  fs.writeFileSync(path.join(__dirname, '..', '.demo-credentials.md'), `${lines.join('\n')}\n`);
  console.log(`Seed complete. Company: ${company.nameEn}. ${people.length} employees. Credentials written to backend/.demo-credentials.md`);
  void owner;
};

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
