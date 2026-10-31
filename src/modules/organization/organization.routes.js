const router = require('express').Router();
const prisma = require('../../database/prisma');
const ah = require('../../utils/asyncHandler');
const { validate, z, str, optStr, optId, optMoney } = require('../../utils/validate');
const { authorize } = require('../../middleware/auth');
const { crudRouter } = require('../../services/crud');
const { badRequest, conflict, notFound } = require('../../utils/errors');
const { assertSameCompany } = require('../../services/common');
const { employeeWhere } = require('../../services/scope');
const audit = require('../../services/audit');

const perm = { view: 'organization.view', create: 'organization.create', edit: 'organization.edit', delete: 'organization.delete' };
const status = z.enum(['ACTIVE', 'INACTIVE']).optional();
const code = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_\-.]+$/, 'Only letters, digits, - _ .');

const ensureNoActiveEmployees = (field) => async (row, ctx) => {
  const n = await prisma.employee.count({ where: { companyId: ctx.companyId, [field]: row.id, deletedAt: null, status: { notIn: ['TERMINATED', 'RESIGNED', 'INACTIVE'] } } });
  if (n) throw conflict('RELATED_RECORDS_EXIST');
};

// ── Branches ──
router.use('/branches', crudRouter({
  model: 'branch', entity: 'Branch', perm, softDelete: true,
  searchFields: ['nameAr', 'nameEn', 'code', 'city'], sortable: ['nameEn', 'nameAr', 'code', 'createdAt'], orderBy: { code: 'asc' },
  include: { manager: { select: { id: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } }, _count: { select: { employees: { where: { deletedAt: null } } } } },
  filters: { status: (v) => ({ status: v }) },
  createSchema: z.object({
    code, nameAr: str(200), nameEn: str(200), city: optStr(100), address: optStr(500), phone: optStr(30),
    latitude: z.coerce.number().min(-90).max(90).nullable().optional(), longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
    managerId: optId, status,
  }),
  beforeDelete: ensureNoActiveEmployees('branchId'),
  exportColumns: [{ header: 'Code', key: 'code' }, { header: 'Name (EN)', key: 'nameEn' }, { header: 'Name (AR)', key: 'nameAr' }, { header: 'City', key: 'city' }, { header: 'Status', key: 'status' }],
}));

// ── Departments / executive units / sections (one self-referencing tree) ──
const wouldCycle = async (companyId, id, parentId) => {
  let cur = parentId;
  const seen = new Set();
  while (cur) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
    const p = await prisma.department.findFirst({ where: { id: cur, companyId }, select: { parentId: true } });
    cur = p?.parentId;
  }
  return false;
};

router.use('/departments', crudRouter({
  model: 'department', entity: 'Department', perm, softDelete: true,
  searchFields: ['nameAr', 'nameEn', 'code'], sortable: ['nameEn', 'nameAr', 'code', 'sortOrder', 'createdAt'], orderBy: { sortOrder: 'asc' },
  include: {
    manager: { select: { id: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } },
    parent: { select: { id: true, nameAr: true, nameEn: true } }, branch: { select: { id: true, nameAr: true, nameEn: true } },
    _count: { select: { employees: { where: { deletedAt: null } } } },
  },
  filters: { type: (v) => ({ type: v }), parentId: (v) => ({ parentId: v === 'root' ? null : v }), branchId: (v) => ({ branchId: v }), status: (v) => ({ status: v }) },
  createSchema: z.object({
    code, nameAr: str(200), nameEn: str(200), type: z.enum(['EXECUTIVE', 'DEPARTMENT', 'SECTION']).default('DEPARTMENT'),
    parentId: optId, branchId: optId, managerId: optId, description: optStr(2000), sortOrder: z.coerce.number().int().optional(), status,
  }),
  toData: async (body, ctx, mode, before) => {
    if (mode === 'update' && body.parentId && (await wouldCycle(ctx.companyId, before.id, body.parentId))) throw badRequest('MANAGER_CYCLE');
    return body;
  },
  beforeDelete: async (row, ctx) => {
    await ensureNoActiveEmployees('departmentId')(row, ctx);
    const kids = await prisma.department.count({ where: { companyId: ctx.companyId, parentId: row.id, deletedAt: null } });
    if (kids) throw conflict('RELATED_RECORDS_EXIST');
  },
  exportColumns: [{ header: 'Code', key: 'code' }, { header: 'Type', key: 'type' }, { header: 'Name (EN)', key: 'nameEn' }, { header: 'Name (AR)', key: 'nameAr' }, { header: 'Status', key: 'status' }],
}));

// ── Teams ──
router.use('/teams', crudRouter({
  model: 'team', entity: 'Team', perm, softDelete: true,
  searchFields: ['nameAr', 'nameEn', 'code'], sortable: ['nameEn', 'code', 'createdAt'], orderBy: { code: 'asc' },
  include: { department: { select: { id: true, nameAr: true, nameEn: true } }, leader: { select: { id: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true } }, _count: { select: { employees: { where: { deletedAt: null } } } } },
  filters: { departmentId: (v) => ({ departmentId: v }) },
  createSchema: z.object({ code, nameAr: str(200), nameEn: str(200), departmentId: z.string().uuid(), leaderId: optId, status }),
  beforeDelete: ensureNoActiveEmployees('teamId'),
}));

// ── Job grades ──
router.use('/grades', crudRouter({
  model: 'jobGrade', entity: 'JobGrade', perm,
  searchFields: ['name', 'code'], sortable: ['level', 'code', 'name'], orderBy: { level: 'asc' },
  createSchema: z.object({ code, name: str(120), level: z.coerce.number().int().min(1).max(100), minSalary: optMoney, maxSalary: optMoney, status }),
  beforeDelete: async (row, ctx) => {
    const n = await prisma.employee.count({ where: { companyId: ctx.companyId, gradeId: row.id } });
    if (n) throw conflict('RELATED_RECORDS_EXIST');
  },
}));

// ── Job positions (separate from employees: many employees can hold one position) ──
router.use('/positions', crudRouter({
  model: 'jobPosition', entity: 'JobPosition', perm, softDelete: true,
  searchFields: ['titleAr', 'titleEn', 'code'], sortable: ['titleEn', 'code', 'level', 'createdAt'], orderBy: { code: 'asc' },
  include: { department: { select: { id: true, nameAr: true, nameEn: true } }, grade: { select: { id: true, name: true, code: true } }, reportsTo: { select: { id: true, titleAr: true, titleEn: true } }, _count: { select: { employees: { where: { deletedAt: null } } } } },
  filters: { departmentId: (v) => ({ departmentId: v }) },
  createSchema: z.object({
    code, titleAr: str(200), titleEn: str(200), departmentId: optId, gradeId: optId, reportsToPositionId: optId,
    level: z.coerce.number().int().min(1).max(100).nullable().optional(), description: optStr(5000), requiredSkills: optStr(5000),
    salaryMin: optMoney, salaryMax: optMoney, status,
  }).refine((v) => !v.salaryMin || !v.salaryMax || Number(v.salaryMin) <= Number(v.salaryMax), { message: 'salaryMin must be <= salaryMax', path: ['salaryMax'] }),
  updateSchema: z.object({
    code: code.optional(), titleAr: str(200).optional(), titleEn: str(200).optional(), departmentId: optId, gradeId: optId, reportsToPositionId: optId,
    level: z.coerce.number().int().min(1).max(100).nullable().optional(), description: optStr(5000), requiredSkills: optStr(5000),
    salaryMin: optMoney, salaryMax: optMoney, status,
  }),
  beforeDelete: ensureNoActiveEmployees('positionId'),
  exportColumns: [{ header: 'Code', key: 'code' }, { header: 'Title (EN)', key: 'titleEn' }, { header: 'Title (AR)', key: 'titleAr' }, { header: 'Level', key: 'level' }],
}));

// ── Organization chart ──
const empCard = { id: true, employeeNumber: true, firstName: true, lastName: true, fullNameAr: true, fullNameEn: true, photoFileId: true, managerId: true, departmentId: true, sectionId: true, teamId: true, branchId: true, status: true, position: { select: { titleAr: true, titleEn: true } } };

router.get('/chart', authorize('organization.view'), ah(async (req, res) => {
  const ctx = req.ctx;
  const mode = req.query.mode === 'people' ? 'people' : 'units';
  const branchId = req.query.branchId || undefined;
  const empWhere = { AND: [await employeeWhere(ctx, ['organization.view', 'employees.view']), { deletedAt: null, status: { notIn: ['TERMINATED', 'RESIGNED'] } }, branchId ? { branchId } : {}] };
  const employees = await prisma.employee.findMany({ where: empWhere, select: empCard, orderBy: { employeeNumber: 'asc' } });

  if (mode === 'people') {
    // reporting-line tree
    const byId = new Map(employees.map((e) => [e.id, { ...e, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.managerId && byId.get(node.managerId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return res.json({ mode, company: { id: ctx.company.id, nameAr: ctx.company.nameAr, nameEn: ctx.company.nameEn }, roots });
  }

  const [departments, teams] = await Promise.all([
    prisma.department.findMany({ where: { companyId: ctx.companyId, deletedAt: null, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, include: { manager: { select: empCard } }, orderBy: { sortOrder: 'asc' } }),
    prisma.team.findMany({ where: { companyId: ctx.companyId, deletedAt: null }, include: { leader: { select: empCard } } }),
  ]);
  const deptNodes = new Map(departments.map((d) => [d.id, { kind: 'unit', ...d, children: [], teams: [], employees: [], headcount: 0 }]));
  for (const t of teams) {
    const parent = deptNodes.get(t.departmentId);
    if (parent) parent.teams.push({ kind: 'team', ...t, employees: [] });
  }
  for (const e of employees) {
    const dept = deptNodes.get(e.sectionId) || deptNodes.get(e.departmentId);
    if (!dept) continue;
    const team = e.teamId && dept.teams.find((t) => t.id === e.teamId);
    (team ? team.employees : dept.employees).push(e);
  }
  const roots = [];
  for (const node of deptNodes.values()) {
    const parent = node.parentId && deptNodes.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const count = (n) => {
    n.headcount = n.employees.length + n.teams.reduce((s, t) => s + t.employees.length, 0) + n.children.reduce((s, c) => s + count(c), 0);
    return n.headcount;
  };
  roots.forEach(count);
  const unassigned = employees.filter((e) => !deptNodes.has(e.departmentId) && !deptNodes.has(e.sectionId));
  res.json({ mode, company: { id: ctx.company.id, nameAr: ctx.company.nameAr, nameEn: ctx.company.nameEn, headcount: employees.length }, roots, unassigned });
}));

// Drag & drop: move a unit under another parent
router.patch('/departments/:id/move', authorize('organization.edit'),
  validate({ body: z.object({ parentId: optId, reason: optStr(500) }) }),
  ah(async (req, res) => {
    const ctx = req.ctx;
    const dep = await prisma.department.findFirst({ where: { id: req.params.id, companyId: ctx.companyId, deletedAt: null } });
    if (!dep) throw notFound();
    await assertSameCompany(ctx.companyId, { parentId: req.body.parentId });
    if (req.body.parentId && (await wouldCycle(ctx.companyId, dep.id, req.body.parentId))) throw badRequest('MANAGER_CYCLE');
    const updated = await prisma.department.update({ where: { id: dep.id }, data: { parentId: req.body.parentId || null } });
    await audit.record(ctx, { action: 'MOVE_UNIT', entityType: 'Department', entityId: dep.id, before: dep, after: updated, reason: req.body.reason });
    res.json(updated);
  }));

// Organizational change history (unit moves + employee transfers)
router.get('/history', authorize('organization.view'), ah(async (req, res) => {
  const items = await prisma.auditLog.findMany({
    where: { companyId: req.ctx.companyId, OR: [{ entityType: { in: ['Department', 'Team', 'JobPosition', 'Branch'] } }, { action: { in: ['TRANSFER_EMPLOYEE', 'CHANGE_DEPARTMENT', 'CHANGE_MANAGER', 'CHANGE_POSITION'] } }] },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json({ items });
}));

module.exports = router;
