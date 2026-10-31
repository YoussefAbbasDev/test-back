// Errors carry a stable `code`; the API translates it (ar/en) and the frontend can also map it.
class AppError extends Error {
  constructor(status, code, params = {}, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
    this.details = details;
  }
}

const badRequest = (code, params, details) => new AppError(400, code, params, details);
const unauthorized = (code = 'UNAUTHORIZED') => new AppError(401, code);
const forbidden = (code = 'FORBIDDEN', params) => new AppError(403, code, params);
const notFound = (code = 'NOT_FOUND', params) => new AppError(404, code, params);
const conflict = (code, params, details) => new AppError(409, code, params, details);
const unprocessable = (code, params, details) => new AppError(422, code, params, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable };
