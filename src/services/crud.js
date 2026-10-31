// Tenant-safe CRUD router factory for master data (branches, departments, shifts, leave types, components…).
// Business-heavy entities (employees, payroll, leaves…) have dedicated services instead.
const express = require('express');
const prisma = require('../database/prisma');
const ah = require('../utils/asyncHandler');
const { validate, listQuery } = require('../utils/validate');
const { authorize } = require('../middleware/auth');
const { parsePaging, parseSort, paged } = require('../utils/pagination');
const { notFound } = require('../utils/errors');
const { assertSameCompany } = require('./common');
const audit = require('./audit');
const exporter = require('./exporter');

/**
 * crudRouter({
 *   model, entity, perm: { view, create, edit, delete }, createSchema, updateSchema,
 *   searchFields, sortable, filters: { queryKey: (value) => where }, include, orderBy,
 *   softDelete, toData(body, ctx), afterWrite(tx, row, ctx), beforeDelete(row, ctx), exportColumns
 * })
 */
const crudRouter = (cfg) => {
  const router = express.Router();
  const p = cfg.perm;
  const toData = cfg.toData || ((b) => b);
  const baseWhere = (ctx) => ({ companyId: ctx.companyId, ...(cfg.softDelete ? { deletedAt: null } : {}) });

  const buildWhere = (ctx, q) => {
    const where = { ...baseWhere(ctx) };
    if (q.search && cfg.searchFields?.length) where.OR = cfg.searchFields.map((f) => ({ [f]: { contains: q.search } }));
    for (const [key, fn] of Object.entries(cfg.filters || {})) {
      if (q[key] !== undefined && q[key] !== '') Object.assign(where, fn(q[key], ctx));
    }
    return where;
  };

  router.get('/', authorize(p.view), validate({ query: listQuery }), ah(async (req, res) => {
    const q = req.validQuery;
    const where = buildWhere(req.ctx, q);
    const orderBy = parseSort(q.sort, cfg.sortable || ['createdAt'], cfg.orderBy || { createdAt: 'desc' });
    if (q.format && q.format !== 'json') {
      const rows = await prisma[cfg.model].findMany({ where, orderBy, include: cfg.include, take: 10000 });
      return exporter.send(res, q.format, { title: cfg.entity, filename: cfg.entity, columns: cfg.exportColumns || Object.keys(rows[0] || {}).map((k) => ({ header: k, key: k })), rows });
    }
    if (q.all === 'true') {
      const items = await prisma[cfg.model].findMany({ where, orderBy, include: cfg.include, take: 2000 });
      return res.json({ items, total: items.length });
    }
    const paging = parsePaging(q);
    const [items, total] = await Promise.all([
      prisma[cfg.model].findMany({ where, orderBy, include: cfg.include, skip: paging.skip, take: paging.take }),
      prisma[cfg.model].count({ where }),
    ]);
    res.json(paged(items, total, paging));
  }));

  router.get('/:id', authorize(p.view), ah(async (req, res) => {
    const row = await prisma[cfg.model].findFirst({ where: { id: req.params.id, ...baseWhere(req.ctx) }, include: cfg.detailInclude || cfg.include });
    if (!row) throw notFound();
    res.json(row);
  }));

  if (p.create) {
    router.post('/', authorize(p.create), validate({ body: cfg.createSchema }), ah(async (req, res) => {
      const data = await toData(req.body, req.ctx, 'create');
      await assertSameCompany(req.ctx.companyId, data);
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx[cfg.model].create({ data: { ...data, companyId: req.ctx.companyId } });
        if (cfg.afterWrite) await cfg.afterWrite(tx, created, req.ctx, req.body);
        await audit.record(req.ctx, { action: 'CREATE', entityType: cfg.entity, entityId: created.id, after: created }, tx);
        return created;
      });
      res.status(201).json(row);
    }));
  }

  if (p.edit) {
    router.put('/:id', authorize(p.edit), validate({ body: cfg.updateSchema || cfg.createSchema.partial() }), ah(async (req, res) => {
      const before = await prisma[cfg.model].findFirst({ where: { id: req.params.id, ...baseWhere(req.ctx) } });
      if (!before) throw notFound();
      const data = await toData(req.body, req.ctx, 'update', before);
      await assertSameCompany(req.ctx.companyId, data);
      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx[cfg.model].update({ where: { id: before.id }, data });
        if (cfg.afterWrite) await cfg.afterWrite(tx, updated, req.ctx, req.body);
        await audit.record(req.ctx, { action: 'UPDATE', entityType: cfg.entity, entityId: updated.id, before, after: updated }, tx);
        return updated;
      });
      res.json(row);
    }));
  }

  if (p.delete) {
    router.delete('/:id', authorize(p.delete), ah(async (req, res) => {
      const before = await prisma[cfg.model].findFirst({ where: { id: req.params.id, ...baseWhere(req.ctx) } });
      if (!before) throw notFound();
      if (cfg.beforeDelete) await cfg.beforeDelete(before, req.ctx);
      if (cfg.softDelete) await prisma[cfg.model].update({ where: { id: before.id }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
      else await prisma[cfg.model].delete({ where: { id: before.id } });
      await audit.record(req.ctx, { action: 'DELETE', entityType: cfg.entity, entityId: before.id, before });
      res.status(204).end();
    }));
  }

  return router;
};

module.exports = { crudRouter };
