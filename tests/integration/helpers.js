// Test tenants are provisioned through the same code path as real companies, with unique codes per run.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const prisma = require('../../src/database/prisma');
const app = require('../../src/app');
const { provisionCompany } = require('../../src/services/provision');
const { toDateOnly } = require('../../src/utils/dates');

const PASSWORD = `Test-${crypto.randomBytes(6).toString('hex')}9`;
let hashCache;
const hash = async () => (hashCache ??= await bcrypt.hash(PASSWORD, 4));

const createTenant = async (label = 'T') => {
  const code = `${label}-${crypto.randomBytes(4).toString('hex')}`;
  const company = await prisma.company.create({ data: { code, nameAr: `شركة ${code}`, nameEn: `Company ${code}`, weekendDays: [5, 6], timezone: 'Asia/Riyadh' } });
  const { roles } = await prisma.$transaction((tx) => provisionCompany(tx, company), { timeout: 60000 });
  const branch = await prisma.branch.create({ data: { companyId: company.id, code: 'B1', nameAr: 'فرع', nameEn: 'Main Branch', latitude: 24.7136, longitude: 46.6753 } });
  await prisma.attendanceLocation.create({ data: { companyId: company.id, branchId: branch.id, name: 'Main', latitude: 24.7136, longitude: 46.6753, radiusMeters: 200 } });
  const dept = await prisma.department.create({ data: { companyId: company.id, code: 'D1', nameAr: 'إدارة', nameEn: 'Operations' } });
  return { company, roles, branch, dept, code };
};

// Creates an employee + login with the given roles; returns { employee, user, token }
const addPerson = async (t, key, roleCodes, extra = {}) => {
  const employee = await prisma.employee.create({
    data: {
      companyId: t.company.id, employeeNumber: `${key.toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`, firstName: key, lastName: 'Test',
      hireDate: toDateOnly('2024-01-01'), branchId: t.branch.id, departmentId: t.dept.id, status: 'ACTIVE', iban: null, ...extra,
    },
  });
  const email = `${key}.${t.code}@test.local`.toLowerCase();
  const user = await prisma.user.create({
    data: { companyId: t.company.id, employeeId: employee.id, email, displayName: key, passwordHash: await hash(), roles: { create: roleCodes.map((c) => ({ roleId: t.roles[c].id })) } },
  });
  const token = await login(email);
  return { employee, user, token, email };
};

const login = async (email, password = PASSWORD) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
};

const api = (token) => {
  const wrap = (method) => (url) => request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', 'en');
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
};

module.exports = { createTenant, addPerson, login, api, app, prisma, PASSWORD };
