const { z } = require('zod');
const { AppError } = require('./errors');

// validate({ body, query, params }) – parsed values replace the originals so services receive clean data
const validate = (schemas) => (req, res, next) => {
  try {
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const result = schemas[key].safeParse(req[key] ?? {});
      if (!result.success) {
        const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
        throw new AppError(422, 'VALIDATION_FAILED', {}, fields);
      }
      if (key === 'query') req.validQuery = result.data;
      else req[key] = result.data;
    }
    next();
  } catch (e) {
    next(e);
  }
};

// Shared zod helpers
const id = z.string().uuid();
const optId = z.string().uuid().nullable().optional().or(z.literal('').transform(() => null));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const optDate = date.nullable().optional().or(z.literal('').transform(() => null));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
const money = z
  .union([z.number(), z.string()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), 'Invalid amount');
const nonNegativeMoney = money.refine((v) => Number(v) >= 0, 'Amount cannot be negative');
const positiveMoney = money.refine((v) => Number(v) > 0, 'Amount must be greater than zero');
const optMoney = nonNegativeMoney.nullable().optional().or(z.literal('').transform(() => null));
const str = (max = 200) => z.string().trim().min(1).max(max);
const optStr = (max = 200) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const idList = z.array(z.string().uuid()).optional().nullable();
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
const listQuery = z
  .object({
    page: z.coerce.number().optional(),
    pageSize: z.coerce.number().optional(),
    sort: z.string().max(60).optional(),
    search: z.string().max(100).optional(),
    format: z.enum(['json', 'xlsx', 'pdf', 'csv']).optional(),
  })
  .passthrough();

module.exports = {
  validate, z, id, optId, date, optDate, time, money, nonNegativeMoney, positiveMoney, optMoney, str, optStr, idList, bool, listQuery,
};
