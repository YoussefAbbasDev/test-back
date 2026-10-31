const { Prisma } = require('@prisma/client');
const logger = require('../config/logger');
const { AppError } = require('../utils/errors');
const messages = require('../config/messages');

const pickLang = (req) => {
  const q = (req.get('accept-language') || '').toLowerCase();
  return q.startsWith('en') ? 'en' : 'ar';
};

const render = (code, params, lang) => {
  const template = messages[lang]?.[code] || messages.en[code] || code;
  return template.replace(/\{(\w+)\}/g, (_, k) => (params?.[k] ?? `{${k}}`));
};

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const lang = pickLang(req);
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let params = {};
  let details;

  if (err instanceof AppError) {
    ({ status, code, params, details } = err);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') { status = 409; code = 'DUPLICATE_VALUE'; params = { field: [].concat(err.meta?.target || []).join(', ') }; }
    else if (err.code === 'P2003') { status = 409; code = 'RELATED_RECORDS_EXIST'; }
    else if (err.code === 'P2025') { status = 404; code = 'NOT_FOUND'; }
  } else if (err?.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON';
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    status = 413; code = 'FILE_TOO_LARGE';
  }

  if (status >= 500) logger.error({ err, path: req.path }, 'unhandled error');
  res.status(status).json({ error: { code, message: render(code, params, lang), params, details } });
};

module.exports.render = render;
