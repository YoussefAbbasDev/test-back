import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createTenant, addPerson, login, api, app, prisma, PASSWORD } = require('./helpers');

let A; let B; let hrA; let empA; let emp2A; let hrB;

beforeAll(async () => {
  A = await createTenant('SECA');
  B = await createTenant('SECB');
  hrA = await addPerson(A, 'hrmgr', ['HR_MANAGER', 'EMPLOYEE']);
  empA = await addPerson(A, 'staff', ['EMPLOYEE']);
  emp2A = await addPerson(A, 'staff2', ['EMPLOYEE']);
  hrB = await addPerson(B, 'hrmgrb', ['HR_MANAGER', 'EMPLOYEE']);
});
afterAll(() => prisma.$disconnect());

describe('authentication', () => {
  it('rejects missing, malformed, expired and wrongly-signed tokens', async () => {
    expect((await request(app).get('/api/v1/employees')).status).toBe(401);
    expect((await request(app).get('/api/v1/employees').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(401);
    const forged = jwt.sign({ sub: hrA.user.id }, 'not-the-real-secret-not-the-real-secret', { issuer: 'seeda-hrms' });
    expect((await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = jwt.sign({ sub: hrA.user.id }, process.env.JWT_ACCESS_SECRET, { issuer: 'seeda-hrms', expiresIn: -10 });
    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    const none = jwt.sign({ sub: hrA.user.id, iss: 'seeda-hrms' }, '', { algorithm: 'none' });
    expect((await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${none}`)).status).toBe(401);
  });

  it('returns the same error for unknown email and wrong password, then locks after 5 failures', async () => {
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@test.local', password: 'x' });
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: emp2A.email, password: 'wrong-password' });
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    for (let i = 0; i < 4; i++) await request(app).post('/api/v1/auth/login').send({ email: emp2A.email, password: 'wrong-password' });
    const locked = await request(app).post('/api/v1/auth/login').send({ email: emp2A.email, password: PASSWORD });
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    await prisma.user.update({ where: { id: emp2A.user.id }, data: { lockedUntil: null, failedLogins: 0 } });
  });

  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const agent = request.agent(app);
    const first = await agent.post('/api/v1/auth/login').send({ email: empA.email, password: PASSWORD });
    const cookie1 = first.headers['set-cookie'][0];
    expect(cookie1).toMatch(/HttpOnly/i);
    expect(cookie1).toMatch(/SameSite=Strict/i);
    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie1);
    expect(r1.status).toBe(200);
    const cookie2 = r1.headers['set-cookie'][0];
    // replaying the first cookie = theft signal
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie1);
    expect(replay.status).toBe(401);
    // and the legitimately rotated token is now revoked too
    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie2);
    expect(after.status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('cannot read, update or list another company\'s employees even with a valid id', async () => {
    const foreignId = hrB.employee.id;
    expect((await api(hrA.token).get(`/employees/${foreignId}`)).status).toBe(404);
    expect((await api(hrA.token).put(`/employees/${foreignId}`).send({ firstName: 'Hacked' })).status).toBe(404);
    const list = await api(hrA.token).get('/employees?pageSize=200');
    expect(list.body.items.find((e) => e.id === foreignId)).toBeUndefined();
    const fresh = await prisma.employee.findUnique({ where: { id: foreignId } });
    expect(fresh.firstName).toBe('hrmgrb');
  });

  it('cannot link records to another company\'s branch / manager', async () => {
    const res = await api(hrA.token).post('/employees').send({ firstName: 'X', lastName: 'Y', hireDate: '2026-01-01', branchId: B.branch.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REFERENCE');
    const res2 = await api(hrA.token).put(`/employees/${empA.employee.id}`).send({ managerId: hrB.employee.id });
    expect(res2.status).toBe(400);
  });

  it('ignores a client-supplied X-Company-Id for non super-admins', async () => {
    const res = await api(hrA.token).get('/employees?pageSize=200').set('X-Company-Id', B.company.id);
    expect(res.body.items.every((e) => e.companyId === A.company.id)).toBe(true);
  });
});

describe('authorization & privilege escalation', () => {
  it('employees cannot create employees or view other employees', async () => {
    expect((await api(empA.token).post('/employees').send({ firstName: 'X', lastName: 'Y', hireDate: '2026-01-01' })).status).toBe(403);
    const other = await api(empA.token).get(`/employees/${hrA.employee.id}`);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('OUT_OF_SCOPE');
    const own = await api(empA.token).get(`/employees/${empA.employee.id}`);
    expect(own.status).toBe(200);
    const list = await api(empA.token).get('/employees');
    expect(list.body.items.map((e) => e.id)).toEqual([empA.employee.id]);
  });

  it('hides financial fields from users without employees.financial', async () => {
    await prisma.employee.update({ where: { id: emp2A.employee.id }, data: { iban: 'SA0380000000608010167519' } });
    const officer = await addPerson(A, 'officer', ['HR_OFFICER']);
    const res = await api(officer.token).get(`/employees/${emp2A.employee.id}`);
    expect(res.status).toBe(200);
    expect(res.body.iban).toBeUndefined();
    const hr = await api(hrA.token).get(`/employees/${emp2A.employee.id}`);
    expect(hr.body.iban).toBe('SA0380000000608010167519');
  });

  it('cannot grant roles or permissions the caller does not hold', async () => {
    const officer = await addPerson(A, 'officer2', ['HR_OFFICER']);
    // a user administrator who may manage roles but holds no payroll permissions
    const perms = await prisma.permission.findMany({ where: { code: { in: ['users.view', 'users.create', 'users.edit', 'users.settings'] } } });
    const admin = await prisma.role.create({ data: { companyId: A.company.id, code: `USER_ADMIN_${Date.now()}`, nameAr: 'x', nameEn: 'User admin', dataScope: 'COMPANY', permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
    const ua = await addPerson(A, 'useradmin', []);
    await prisma.userRole.create({ data: { userId: ua.user.id, roleId: admin.id } });
    const roleRes = await api(ua.token).post('/settings/roles').send({ code: 'SUPER_PAY', nameAr: 'x', nameEn: 'x', dataScope: 'COMPANY', permissions: ['payroll.settings'] });
    expect(roleRes.status).toBe(403);
    expect(roleRes.body.error.code).toBe('CANNOT_ESCALATE');
    const ownScope = await api(ua.token).post('/settings/roles').send({ code: 'VIEWER', nameAr: 'x', nameEn: 'x', dataScope: 'COMPANY', permissions: ['users.view'] });
    expect(ownScope.status).toBe(201);
    const userRes = await api(hrA.token).post('/settings/users').send({ email: 'esc@test.local', displayName: 'x', password: 'Strong-pass-123', roleIds: [A.roles.COMPANY_OWNER.id] });
    expect(userRes.status).toBe(403);
    expect((await api(officer.token).get('/settings/roles')).status).toBe(403);
  });

  it('employees cannot see other employees\' payslips or leave requests', async () => {
    const res = await api(empA.token).get('/payslips?pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.items.every((p) => p.employeeId === empA.employee.id)).toBe(true);
    const leaves = await api(empA.token).get('/leaves/requests');
    expect(leaves.body.items.every((l) => l.employeeId === empA.employee.id)).toBe(true);
  });

  it('audit log has no write endpoints', async () => {
    expect((await api(hrA.token).delete('/audit')).status).toBe(404);
    expect((await api(hrA.token).post('/audit').send({})).status).toBe(404);
  });
});

describe('injection & input handling', () => {
  it('treats SQL meta-characters in search as plain text', async () => {
    const res = await api(hrA.token).get(`/employees?search=${encodeURIComponent("' OR 1=1 -- ")}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
  it('stores script payloads as inert text and always answers JSON', async () => {
    const payload = '<script>alert(1)</script>';
    const res = await api(hrA.token).put(`/employees/${empA.employee.id}`).send({ address: payload });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.address).toBe(payload);
  });
  it('rejects invalid input with field-level validation errors in the requested language', async () => {
    const res = await request(app).post('/api/v1/employees').set('Authorization', `Bearer ${hrA.token}`).set('Accept-Language', 'ar').send({ firstName: '', hireDate: 'not-a-date', iban: 'SA00123' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/[؀-ۿ]/);
    expect(res.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['firstName', 'hireDate', 'iban']));
  });
  it('rejects unsafe sort fields and oversized pages gracefully', async () => {
    const res = await api(hrA.token).get('/employees?sort=passwordHash&pageSize=100000');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBeLessThanOrEqual(200);
  });
  it('sets security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  it('exposes rate-limit headers', async () => {
    const res = await api(hrA.token).get('/auth/me');
    expect(res.headers['ratelimit-policy'] || res.headers.ratelimit).toBeDefined();
  });
});

describe('business rules', () => {
  it('rejects duplicate employee numbers within a company but allows them across companies', async () => {
    const number = `DUP-${Date.now()}`;
    expect((await api(hrA.token).post('/employees').send({ employeeNumber: number, firstName: 'A', lastName: 'B', hireDate: '2026-01-01' })).status).toBe(201);
    const dup = await api(hrA.token).post('/employees').send({ employeeNumber: number, firstName: 'C', lastName: 'D', hireDate: '2026-01-01' });
    expect(dup.status).toBe(409);
    expect((await api(hrB.token).post('/employees').send({ employeeNumber: number, firstName: 'E', lastName: 'F', hireDate: '2026-01-01' })).status).toBe(201);
  });
  it('prevents manager cycles', async () => {
    await api(hrA.token).put(`/employees/${empA.employee.id}`).send({ managerId: emp2A.employee.id });
    const res = await api(hrA.token).put(`/employees/${emp2A.employee.id}`).send({ managerId: empA.employee.id });
    expect(res.body.error.code).toBe('MANAGER_CYCLE');
  });
  it('keeps employment history when transferring', async () => {
    const dept2 = await prisma.department.create({ data: { companyId: A.company.id, code: `D2-${Date.now()}`, nameAr: 'مبيعات', nameEn: 'Sales' } });
    const res = await api(hrA.token).post(`/employees/${emp2A.employee.id}/transfer`).send({ departmentId: dept2.id, effectiveDate: '2026-10-01', reason: 'Reorg' });
    expect(res.status).toBe(200);
    const hist = await prisma.employeeEmploymentHistory.findFirst({ where: { employeeId: emp2A.employee.id, field: 'departmentId' } });
    expect(hist.oldValue).toBe(A.dept.id);
    expect(hist.newValue).toBe(dept2.id);
    expect(hist.reason).toBe('Reorg');
  });
});

void login;
