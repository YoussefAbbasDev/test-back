// Safe arithmetic formula evaluator for salary components. No eval / Function / SQL.
// Grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ;
//          factor := NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')' | '-' factor
// Functions: min, max, round(x, d), floor, ceil, abs, if(cond>0, a, b)
const { D } = require('../utils/money');
const { badRequest } = require('../utils/errors');

const FUNCS = new Set(['MIN', 'MAX', 'ROUND', 'FLOOR', 'CEIL', 'ABS', 'IF']);
const MAX_LEN = 500;

const tokenize = (src) => {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(num)) throw badRequest('INVALID_FORMULA', { reason: `bad number ${num}` });
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if ('+-*/(),'.includes(c)) { tokens.push({ t: c }); i++; continue; }
    throw badRequest('INVALID_FORMULA', { reason: `unexpected "${c}"` });
  }
  return tokens;
};

const parse = (src) => {
  if (typeof src !== 'string' || !src.trim()) throw badRequest('INVALID_FORMULA', { reason: 'empty' });
  if (src.length > MAX_LEN) throw badRequest('INVALID_FORMULA', { reason: 'too long' });
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    if (tokens[pos]?.t !== t) throw badRequest('INVALID_FORMULA', { reason: `expected ${t}` });
    return tokens[pos++];
  };
  const expr = () => {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = tokens[pos++].t; node = { op, a: node, b: term() }; }
    return node;
  };
  const term = () => {
    let node = factor();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = tokens[pos++].t; node = { op, a: node, b: factor() }; }
    return node;
  };
  const factor = () => {
    const tok = peek();
    if (!tok) throw badRequest('INVALID_FORMULA', { reason: 'unexpected end' });
    if (tok.t === '-') { pos++; return { op: 'neg', a: factor() }; }
    if (tok.t === 'num') { pos++; return { num: tok.v }; }
    if (tok.t === '(') { pos++; const n = expr(); eat(')'); return n; }
    if (tok.t === 'id') {
      pos++;
      if (peek()?.t === '(') {
        if (!FUNCS.has(tok.v)) throw badRequest('INVALID_FORMULA', { reason: `unknown function ${tok.v}` });
        pos++;
        const args = [];
        if (peek()?.t !== ')') {
          args.push(expr());
          while (peek()?.t === ',') { pos++; args.push(expr()); }
        }
        eat(')');
        return { fn: tok.v, args };
      }
      return { id: tok.v };
    }
    throw badRequest('INVALID_FORMULA', { reason: `unexpected ${tok.t}` });
  };
  const ast = expr();
  if (pos !== tokens.length) throw badRequest('INVALID_FORMULA', { reason: 'trailing input' });
  return ast;
};

const variablesOf = (ast, out = new Set()) => {
  if (ast.id) out.add(ast.id);
  if (ast.a) variablesOf(ast.a, out);
  if (ast.b) variablesOf(ast.b, out);
  if (ast.args) ast.args.forEach((x) => variablesOf(x, out));
  return out;
};

const evaluate = (src, vars = {}) => {
  const ast = typeof src === 'string' ? parse(src) : src;
  const ev = (n) => {
    if (n.num !== undefined) return D(n.num);
    if (n.id !== undefined) {
      if (!(n.id in vars)) throw badRequest('INVALID_FORMULA', { reason: `unknown variable ${n.id}` });
      return D(vars[n.id]);
    }
    if (n.op === 'neg') return ev(n.a).negated();
    if (n.op) {
      const a = ev(n.a);
      const b = ev(n.b);
      if (n.op === '+') return a.plus(b);
      if (n.op === '-') return a.minus(b);
      if (n.op === '*') return a.times(b);
      if (n.op === '/') return b.isZero() ? D(0) : a.dividedBy(b);
    }
    const args = n.args.map(ev);
    switch (n.fn) {
      case 'MIN': return args.reduce((m, x) => (x.lessThan(m) ? x : m));
      case 'MAX': return args.reduce((m, x) => (x.greaterThan(m) ? x : m));
      case 'ROUND': return args[0].toDecimalPlaces(args[1] ? args[1].toNumber() : 0);
      case 'FLOOR': return args[0].floor();
      case 'CEIL': return args[0].ceil();
      case 'ABS': return args[0].abs();
      case 'IF': return args[0].greaterThan(0) ? args[1] : args[2] ?? D(0);
      default: throw badRequest('INVALID_FORMULA', { reason: n.fn });
    }
  };
  return ev(ast);
};

// Validates syntax and that every variable is known
const validateFormula = (src, allowedVars) => {
  const ast = parse(src);
  const unknown = [...variablesOf(ast)].filter((v) => !allowedVars.includes(v));
  if (unknown.length) throw badRequest('INVALID_FORMULA', { reason: `unknown variable(s) ${unknown.join(', ')}` });
  return true;
};

const SYSTEM_VARS = ['BASIC', 'GROSS_FIXED', 'PERIOD_DAYS', 'PAID_DAYS', 'PRESENT_DAYS', 'ABSENT_DAYS', 'WORKED_HOURS', 'OT_HOURS', 'LATE_MINUTES', 'SERVICE_YEARS'];

module.exports = { parse, evaluate, validateFormula, variablesOf, SYSTEM_VARS };
