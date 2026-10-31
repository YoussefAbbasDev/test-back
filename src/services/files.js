// Files are stored on disk outside any public folder and only served through authorized endpoints.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const env = require('../config/env');
const prisma = require('../database/prisma');
const { badRequest, notFound } = require('../utils/errors');

const ROOT = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(ROOT, { recursive: true });

const ALLOWED = new Map([
  ['application/pdf', '.pdf'], ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);

// Magic-byte check so a renamed executable cannot pass as a PDF/image
const sniff = (buf) => {
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  return null;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(badRequest('FILE_TYPE_NOT_ALLOWED'))),
});

const save = async (ctx, file, { entityType, entityId } = {}) => {
  if (!file) throw badRequest('FILE_REQUIRED');
  const kind = sniff(file.buffer);
  const declaredZip = file.mimetype.includes('openxmlformats');
  if (!(kind === file.mimetype || (declaredZip && kind === 'zip'))) throw badRequest('FILE_CONTENT_MISMATCH');
  const key = `${ctx.companyId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ALLOWED.get(file.mimetype)}`;
  const full = path.join(ROOT, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, file.buffer);
  return prisma.fileAttachment.create({
    data: {
      companyId: ctx.companyId, storageKey: key, originalName: file.originalname.slice(0, 300), mimeType: file.mimetype,
      size: file.size, entityType: entityType || null, entityId: entityId || null, uploadedById: ctx.userId,
    },
  });
};

const getForCompany = async (companyId, id) => {
  const f = await prisma.fileAttachment.findFirst({ where: { id, companyId } });
  if (!f) throw notFound('FILE_NOT_FOUND');
  const full = path.join(ROOT, f.storageKey);
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) throw notFound('FILE_NOT_FOUND');
  return { file: f, fullPath: full };
};

module.exports = { upload, save, getForCompany, ROOT };
