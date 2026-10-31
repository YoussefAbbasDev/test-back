// OpenAPI document generated from the mounted Express routes, so it always matches the real API surface.
// Request bodies are validated with zod in each route; see the module files for exact field rules.
const TAGS = {
  auth: 'Authentication', dashboard: 'HR Dashboard', employees: 'Employees', organization: 'Organization', attendance: 'Attendance', shifts: 'Shifts & Scheduling',
  leaves: 'Leaves', payroll: 'Payroll', payslips: 'Payslips', commissions: 'Commissions', advances: 'Advances', loans: 'Loans', finance: 'Financial statements & settlements',
  settings: 'Settings, users & roles', approvals: 'Approvals', notifications: 'Notifications', files: 'Files', audit: 'Audit log',
};

const regexpToPath = (layer) => {
  if (layer.path) return layer.path;
  const src = layer.regexp?.source || '';
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  return src.replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace('/?$', '').replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
};

const collect = (stack, prefix, out) => {
  for (const layer of stack) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path}`.replace(/\/+/g, '/');
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m, path });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collect(layer.handle.stack, `${prefix}${regexpToPath(layer)}`, out);
    }
  }
  return out;
};

const buildOpenApi = (app) => {
  const routes = collect(app._router.stack, '', []).filter((r) => r.path.startsWith('/api/v1'));
  const paths = {};
  for (const r of routes) {
    const oaPath = r.path.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
    const segment = oaPath.split('/')[3] || 'system';
    const tag = TAGS[segment] || 'System';
    const params = [...oaPath.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const isPublic = oaPath.startsWith('/api/v1/auth/login') || oaPath.startsWith('/api/v1/auth/refresh') || oaPath.includes('/kiosk/') || oaPath.includes('/integrations/');
    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][r.method] = {
      tags: [tag],
      summary: `${r.method.toUpperCase()} ${oaPath.replace('/api/v1', '')}`,
      parameters: params,
      security: isPublic ? (oaPath.includes('/kiosk/') || oaPath.includes('/integrations/') ? [{ deviceKey: [] }] : []) : [{ bearerAuth: [] }],
      ...(['post', 'put', 'patch'].includes(r.method) ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { 200: { description: 'OK' }, 400: { description: 'Business rule violation' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Permission denied / out of scope' }, 404: { description: 'Not found (also returned for other tenants\' ids)' }, 422: { description: 'Validation failed' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'SEEDA HRMS API', version: '1.0.0',
      description: 'Multi-tenant HRMS API. All endpoints except login/refresh and device endpoints require `Authorization: Bearer <accessToken>`. Errors: `{ error: { code, message, params, details } }` with Arabic/English messages via `Accept-Language`. List endpoints accept `page`, `pageSize`, `sort`, `search` and `format=xlsx|pdf|csv` where export is supported.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        deviceKey: { type: 'apiKey', in: 'header', name: 'X-Device-Key' },
      },
    },
    paths,
  };
};

module.exports = { buildOpenApi };
