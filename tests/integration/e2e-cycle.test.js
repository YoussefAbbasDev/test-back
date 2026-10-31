// Full HR cycle through the HTTP API (spec §22): company → branch → department → employee → manager → shift →
// assignment → check-in/out → leave → commission → advance → payroll → payslip → payment, verified in the database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { login, api, app, prisma, PASSWORD } = require('./helpers');
const { dayjs, fmtDate, localDate } = require('../../src/utils/dates');

const S = {};
const today = fmtDate(localDate(new Date(), 'Asia/Riyadh'));
const monthStart = fmtDate(dayjs.utc(today).startOf('month').toDate());
const monthEnd = fmtDate(dayjs.utc(today).endOf('month').toDate());
// a leave window well in the future, Sunday → Tuesday
const leaveStart = fmtDate(dayjs.utc(today).add(21, 'day').day(0).toDate());
const leaveEnd = fmtDate(dayjs.utc(leaveStart).add(2, 'day').toDate());

beforeAll(async () => {
  const email = `root-${crypto.randomBytes(3).toString('hex')}@test.local`;
  await prisma.user.create({ data: { email, displayName: 'Root', isSuperAdmin: true, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  S.root = await login(email);
});
afterAll(() => prisma.$disconnect());

const people = async (company, owner) => {
  const comps = (await api(owner).get('/payroll/components?all=true')).body.items;
  const id = (code) => comps.find((c) => c.code === code).id;
  const mk = async (firstName, basic, extra = {}) => {
    const res = await api(owner).post('/employees').send({
      firstName, lastName: 'E2E', hireDate: '2025-01-05', branchId: S.branch.id, departmentId: S.dept.id, nationality: 'Saudi', gender: 'MALE',
      paymentMethod: 'BANK', bankName: 'Test Bank', iban: 'SA0380000000608010167519', gosiApplicable: false,
      salary: { lines: [{ componentId: id('BASIC'), amount: String(basic) }, { componentId: id('HOUSING'), amount: String(basic / 4) }] }, ...extra,
    });
    expect(res.status).toBe(201);
    return res.body;
  };
  return { mk, id };
};

describe('end-to-end HR cycle', () => {
  it('1. creates a company with an owner (super admin)', async () => {
    const code = `E2E-${crypto.randomBytes(3).toString('hex')}`;
    const ownerEmail = `owner-${code}@test.local`.toLowerCase();
    const res = await request(app).post('/api/v1/settings/companies').set('Authorization', `Bearer ${S.root}`).send({ code, nameAr: 'شركة اختبار', nameEn: 'E2E Co', owner: { email: ownerEmail, displayName: 'Owner', password: PASSWORD } });
    expect(res.status).toBe(201);
    S.company = res.body;
    S.owner = await login(ownerEmail);
    const roles = (await api(S.owner).get('/settings/roles')).body.items;
    S.role = (c) => roles.find((r) => r.code === c).id;
    expect(roles.length).toBeGreaterThanOrEqual(10);
  });

  it('2-3. creates a branch with a geofence and a department', async () => {
    const br = await api(S.owner).post('/organization/branches').send({ code: 'HQ', nameAr: 'الرئيسي', nameEn: 'HQ', latitude: 24.7136, longitude: 46.6753 });
    expect(br.status).toBe(201);
    S.branch = br.body;
    expect((await api(S.owner).post('/attendance/locations').send({ name: 'HQ', branchId: S.branch.id, latitude: 24.7136, longitude: 46.6753, radiusMeters: 150 })).status).toBe(201);
    const dep = await api(S.owner).post('/organization/departments').send({ code: 'OPS', nameAr: 'العمليات', nameEn: 'Operations' });
    expect(dep.status).toBe(201);
    S.dept = dep.body;
  });

  it('4-5. adds employees with salaries, logins and a manager', async () => {
    const { mk } = await people(S.company, S.owner);
    S.mgrEmp = await mk('Manager', 12000);
    S.empEmp = await mk('Worker', 6000, { managerId: S.mgrEmp.id });
    S.hrEmp = await mk('Hr', 10000);
    S.finEmp = await mk('Fin', 10000);
    S.gmEmp = await mk('Gm', 20000);
    S.payEmp = await mk('Pay', 9000);
    const mkUser = async (emp, roleCodes) => {
      const email = `${emp.firstName.toLowerCase()}-${S.company.code}@test.local`.toLowerCase();
      const res = await api(S.owner).post('/settings/users').send({ email, displayName: emp.firstName, password: PASSWORD, employeeId: emp.id, roleIds: roleCodes.map(S.role) });
      expect(res.status).toBe(201);
      return login(email);
    };
    S.mgr = await mkUser(S.mgrEmp, ['EMPLOYEE', 'SUPERVISOR']);
    S.emp = await mkUser(S.empEmp, ['EMPLOYEE']);
    S.hr = await mkUser(S.hrEmp, ['EMPLOYEE', 'HR_MANAGER']);
    S.fin = await mkUser(S.finEmp, ['EMPLOYEE', 'FINANCE_MANAGER']);
    S.gm = await mkUser(S.gmEmp, ['EMPLOYEE', 'GENERAL_MANAGER']);
    S.pay = await mkUser(S.payEmp, ['EMPLOYEE', 'PAYROLL_MANAGER']);
    const emp = await api(S.hr).get(`/employees/${S.empEmp.id}`);
    expect(emp.body.manager.id).toBe(S.mgrEmp.id);
  });

  it('6-7. creates a shift and assigns the employee (conflicts rejected)', async () => {
    const sh = await api(S.hr).post('/shifts/definitions').send({ code: 'DAY', nameAr: 'نهاري', nameEn: 'Day', startTime: '00:30', endTime: '23:30', breakMinutes: 60, workingDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(sh.status).toBe(201);
    expect(sh.body.expectedMinutes).toBe(1320);
    S.shift = sh.body;
    const a = await api(S.hr).post('/shifts/assignments').send({ employeeIds: [S.empEmp.id], shiftId: S.shift.id, from: today, to: today });
    expect(a.body.created).toBe(1);
    const again = await api(S.hr).post('/shifts/assignments').send({ employeeIds: [S.empEmp.id], shiftId: S.shift.id, from: today, to: today });
    expect(again.body.created).toBe(0);
    expect(again.body.skipped[0].code).toBe('SHIFT_CONFLICT');
  });

  it('8-9. checks in and out with GPS inside the geofence (outside is rejected)', async () => {
    const outside = await api(S.emp).post('/attendance/check-in').send({ method: 'GPS', latitude: 24.80, longitude: 46.6753, accuracy: 10 });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('OUTSIDE_GEOFENCE');
    const inn = await api(S.emp).post('/attendance/check-in').send({ method: 'GPS', latitude: 24.7137, longitude: 46.6754, accuracy: 12 });
    expect(inn.status).toBe(201);
    const dup = await api(S.emp).post('/attendance/check-in').send({ method: 'GPS', latitude: 24.7137, longitude: 46.6754, accuracy: 12 });
    expect(dup.status).toBe(409);
    const out = await api(S.emp).post('/attendance/check-out').send({ method: 'GPS', latitude: 24.7137, longitude: 46.6754, accuracy: 12 });
    expect(out.status).toBe(201);
    const rec = await prisma.attendanceRecord.findFirst({ where: { employeeId: S.empEmp.id }, include: { events: true } });
    expect(rec.events).toHaveLength(2);
    expect(rec.shiftId).toBe(S.shift.id);
    expect(rec.firstCheckIn).not.toBeNull();
    expect(rec.lastCheckOut).not.toBeNull();
  });

  it('10-11. submits a leave request and approves it through manager → HR', async () => {
    const types = (await api(S.hr).get('/leaves/types?all=true')).body.items;
    expect(types.length).toBe(0); // fresh company: leave types are company-defined, not hard-coded
    const t = await api(S.hr).post('/leaves/types').send({ code: 'AL', nameAr: 'سنوية', nameEn: 'Annual', category: 'ANNUAL', isPaid: true });
    await api(S.hr).post('/leaves/policies').send({ leaveTypeId: t.body.id, name: 'Annual', annualEntitlement: '21', accrualMethod: 'UPFRONT', effectiveFrom: '2020-01-01', carryForwardMax: '5' });
    const req = await api(S.emp).post('/leaves/requests').send({ leaveTypeId: t.body.id, startDate: leaveStart, endDate: leaveEnd, reason: 'Trip' });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('PENDING_MANAGER');
    expect(Number(req.body.days)).toBe(3);
    // HR cannot jump the queue
    expect((await api(S.hr).post(`/leaves/requests/${req.body.id}/approve`).send({})).status).toBe(403);
    expect((await api(S.mgr).post(`/leaves/requests/${req.body.id}/approve`).send({})).status).toBe(200);
    expect((await prisma.leaveRequest.findUnique({ where: { id: req.body.id } })).status).toBe('PENDING_HR');
    expect((await api(S.hr).post(`/leaves/requests/${req.body.id}/approve`).send({ comment: 'ok' })).status).toBe(200);
    const final = await prisma.leaveRequest.findUnique({ where: { id: req.body.id } });
    expect(final.status).toBe('APPROVED');
    const bal = await prisma.leaveBalance.findFirst({ where: { employeeId: S.empEmp.id } });
    expect(Number(bal.used)).toBe(3);
    expect(Number(bal.pending)).toBe(0);
    // overlapping request is refused
    const overlap = await api(S.emp).post('/leaves/requests').send({ leaveTypeId: t.body.id, startDate: leaveStart, endDate: leaveStart });
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
  });

  it('12-13. calculates a commission once and approves it', async () => {
    const rule = await api(S.owner).post('/commissions/rules').send({ code: 'P5', nameAr: '5%', nameEn: '5%', type: 'PERCENT_SALES', calculationBase: 'SALES_AMOUNT', value: '5', effectiveFrom: '2020-01-01', participantRole: 'ANY' });
    expect(rule.status).toBe(201);
    const bad = await api(S.pay).post('/commissions/source-transactions').send({ externalRef: 'JOB-X', transactionDate: today, salesAmount: '10000', participants: [{ employeeId: S.empEmp.id, sharePercent: '60' }] });
    expect(bad.body.error.code).toBe('DISTRIBUTION_NOT_100');
    const src = await api(S.pay).post('/commissions/source-transactions').send({ externalRef: 'JOB-1', branchId: S.branch.id, transactionDate: today, salesAmount: '10000', qualityApproved: true, participants: [{ employeeId: S.empEmp.id, sharePercent: '70' }, { employeeId: S.mgrEmp.id, role: 'SUPERVISOR', sharePercent: '30' }] });
    expect(src.status).toBe(201);
    const c1 = await api(S.pay).post('/commissions/calculate').send({ from: today, to: today });
    expect(c1.body.created).toBe(2);
    const c2 = await api(S.pay).post('/commissions/calculate').send({ from: today, to: today });
    expect(c2.body.created).toBe(0); // no double commission for the same operation
    const entries = await prisma.commissionTransaction.findMany({ where: { companyId: S.company.id } });
    expect(entries.map((e) => Number(e.netAmount)).sort()).toEqual([150, 350]);
    const appr = await api(S.fin).post('/commissions/bulk/approve').send({ ids: entries.map((e) => e.id) });
    expect(appr.body.results.every((r) => r.ok)).toBe(true);
  });

  it('14-15. requests an advance, approves and disburses it', async () => {
    const adv = await api(S.emp).post('/advances').send({ amount: '1200', reason: 'Need', installmentCount: 2, firstDeductionDate: monthStart });
    expect(adv.status).toBe(201);
    expect((await api(S.mgr).post(`/advances/${adv.body.id}/approve`).send({})).status).toBe(200);
    const detail = await api(S.fin).get(`/advances/${adv.body.id}`);
    expect(detail.body.status).toBe('APPROVED');
    expect(detail.body.installments.map((i) => Number(i.amount))).toEqual([600, 600]);
    expect((await api(S.fin).post(`/advances/${adv.body.id}/disburse`).send({ note: 'paid' })).status).toBe(200);
    S.advanceId = adv.body.id;
  });

  it('16-19. creates, calculates, reviews and approves a payroll run (HR → Finance → GM)', async () => {
    const per = await api(S.pay).post('/payroll/periods').send({ name: 'E2E month', startDate: monthStart, endDate: monthEnd, paymentDate: monthEnd });
    expect(per.status).toBe(201);
    const run = await api(S.pay).post('/payroll/runs').send({ periodId: per.body.id });
    expect(run.status).toBe(201);
    S.run = run.body;
    const calc = await api(S.pay).post(`/payroll/runs/${S.run.id}/calculate`);
    expect(calc.status).toBe(200);
    const detail = await api(S.pay).get(`/payroll/runs/${S.run.id}`);
    const worker = detail.body.employees.find((e) => e.employeeId === S.empEmp.id);
    const amount = (code) => worker.lines.filter((l) => l.code === code).reduce((s, l) => s + Number(l.amount), 0);
    expect(amount('BASIC')).toBe(6000);
    expect(amount('HOUSING')).toBe(1500);
    expect(amount('COMMISSION')).toBe(350);
    expect(amount('ADVANCE')).toBe(600);
    expect(Number(worker.netSalary)).toBe(6000 + 1500 + 350 - 600);
    // approvals
    expect((await api(S.pay).post(`/payroll/runs/${S.run.id}/submit`)).status).toBe(200);
    expect((await api(S.fin).post(`/payroll/runs/${S.run.id}/approve`).send({})).status).toBe(403); // not their step yet
    for (const tok of [S.hr, S.fin, S.gm]) expect((await api(tok).post(`/payroll/runs/${S.run.id}/approve`).send({})).status).toBe(200);
    expect((await prisma.payrollRun.findUnique({ where: { id: S.run.id } })).status).toBe('APPROVED');
  });

  it('20. locks the run atomically and issues payslips', async () => {
    const lock = await api(S.gm).post(`/payroll/runs/${S.run.id}/lock`);
    expect(lock.status).toBe(200);
    expect(lock.body.status).toBe('LOCKED');
    const comm = await prisma.commissionTransaction.findMany({ where: { companyId: S.company.id, employeeId: S.empEmp.id } });
    expect(comm.every((c) => c.status === 'INCLUDED_IN_PAYROLL' && c.payrollRunId === S.run.id)).toBe(true);
    const inst = await prisma.installment.findMany({ where: { advanceId: S.advanceId }, orderBy: { number: 'asc' } });
    expect(inst[0].status).toBe('PAID');
    const ledger = await prisma.financialLedgerEntry.findFirst({ where: { advanceId: S.advanceId }, orderBy: { createdAt: 'desc' } });
    expect(Number(ledger.balanceAfter)).toBe(600);
    // locked runs cannot be recalculated
    expect((await api(S.pay).post(`/payroll/runs/${S.run.id}/calculate`)).body.error.code).toBe('PAYROLL_LOCKED');
    // employee sees exactly their own payslip
    const mine = await api(S.emp).get('/payslips?mine=true');
    expect(mine.body.items).toHaveLength(1);
    const ps = mine.body.items[0];
    expect(Number(ps.netSalary)).toBe(7250);
    const pdf = await api(S.emp).get(`/payslips/${ps.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await api(S.mgr).get(`/payslips/${ps.id}`)).status).toBe(403);
    expect(await prisma.payslipDownloadLog.count({ where: { payslipId: ps.id } })).toBeGreaterThan(0);
  });

  it('21. records payment and marks commissions paid', async () => {
    const pay = await api(S.fin).post(`/payroll/runs/${S.run.id}/payments`).send({ reference: 'BATCH-1' });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe('PAID');
    const ps = await prisma.payslip.findFirst({ where: { runId: S.run.id, employeeId: S.empEmp.id } });
    expect(ps.status).toBe('PAID');
    const comm = await prisma.commissionTransaction.findMany({ where: { companyId: S.company.id, employeeId: S.empEmp.id } });
    expect(comm.every((c) => c.status === 'PAID')).toBe(true);
    const bank = await api(S.pay).get(`/payroll/runs/${S.run.id}/bank-file`);
    expect(bank.status).toBe(200);
    expect(bank.text).toContain('SA0380000000608010167519');
    const audit = await prisma.auditLog.count({ where: { companyId: S.company.id, action: { in: ['PAYROLL_LOCKED', 'PAYROLL_PAYMENT_RECORDED', 'LEAVE_APPROVED'] } } });
    expect(audit).toBeGreaterThanOrEqual(3);
  });

  it('reverses a locked run without editing the original', async () => {
    const rev = await api(S.gm).post(`/payroll/runs/${S.run.id}/reverse`).send({ reason: 'Test reversal' });
    expect(rev.status).toBe(201);
    expect(Number(rev.body.totalNet)).toBeLessThan(0);
    const orig = await prisma.payrollRun.findUnique({ where: { id: S.run.id } });
    expect(orig.status).toBe('REVERSED');
    const inst = await prisma.installment.findMany({ where: { advanceId: S.advanceId }, orderBy: { number: 'asc' } });
    expect(Number(inst[0].paidAmount)).toBe(0);
    const comm = await prisma.commissionTransaction.findMany({ where: { companyId: S.company.id, employeeId: S.empEmp.id } });
    expect(comm.every((c) => c.status === 'PAYABLE' && c.payrollRunId === null)).toBe(true);
  });
});
