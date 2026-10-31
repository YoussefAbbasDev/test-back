const prisma = require('../database/prisma');
const logger = require('../config/logger');

const SENSITIVE = new Set(['passwordHash', 'kioskPinHash', 'apiKeyHash', 'tokenHash']);

const clean = (obj) => {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.has(k)) continue;
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v && typeof v === 'object' && typeof v.toFixed === 'function') out[k] = v.toString(); // Decimal
    else if (v && typeof v === 'object' && !Array.isArray(v)) continue; // skip nested relations
    else out[k] = v;
  }
  return out;
};

// Only changed keys are stored for updates, keeping the log readable.
const diff = (before, after) => {
  const b = clean(before) || {};
  const a = clean(after) || {};
  const oldValue = {};
  const newValue = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (['updatedAt', 'createdAt'].includes(k)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      oldValue[k] = b[k] ?? null;
      newValue[k] = a[k] ?? null;
    }
  }
  return { oldValue, newValue };
};

/**
 * record(ctx, { action, entityType, entityId, employeeId, before, after, reason }, tx?)
 * Append-only; failures are logged but never block the business transaction when outside one.
 */
const record = async (ctx, { action, entityType, entityId, employeeId, before, after, reason, oldValue, newValue }, tx = prisma) => {
  let ov = oldValue;
  let nv = newValue;
  if (ov === undefined && nv === undefined) {
    if (before && after) ({ oldValue: ov, newValue: nv } = diff(before, after));
    else {
      ov = before ? clean(before) : null;
      nv = after ? clean(after) : null;
    }
  }
  const data = {
    companyId: ctx?.companyId || null,
    userId: ctx?.userId || null,
    userName: ctx?.userName || null,
    action,
    entityType,
    entityId: entityId || null,
    employeeId: employeeId || null,
    oldValue: ov ?? undefined,
    newValue: nv ?? undefined,
    reason: reason ? String(reason).slice(0, 500) : null,
    ip: ctx?.ip || null,
    userAgent: ctx?.userAgent || null,
  };
  if (tx !== prisma) return tx.auditLog.create({ data });
  try {
    return await prisma.auditLog.create({ data });
  } catch (e) {
    logger.error({ err: e }, 'audit log write failed');
    return null;
  }
};

module.exports = { record, diff, clean };
