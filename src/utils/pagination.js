const parsePaging = (query, { defaultSize = 20, maxSize = 200 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

// sort=field or sort=-field, restricted to an allow-list to avoid arbitrary column ordering
const parseSort = (sort, allowed, fallback = { createdAt: 'desc' }) => {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? 'desc' : 'asc' };
};

const paged = (items, total, { page, pageSize }) => ({ items, total, page, pageSize, pages: Math.ceil(total / pageSize) });

module.exports = { parsePaging, parseSort, paged };
