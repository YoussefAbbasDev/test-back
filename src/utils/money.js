const Decimal = require('decimal.js');

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

const D = (v) => new Decimal(v === null || v === undefined || v === '' ? 0 : v.toString());
const ZERO = new Decimal(0);

const ROUNDING = { HALF_UP: Decimal.ROUND_HALF_UP, DOWN: Decimal.ROUND_DOWN, UP: Decimal.ROUND_UP };
const round = (v, decimals = 2, mode = 'HALF_UP') => D(v).toDecimalPlaces(decimals, ROUNDING[mode] ?? Decimal.ROUND_HALF_UP);
const sum = (arr, pick = (x) => x) => arr.reduce((acc, x) => acc.plus(D(pick(x))), new Decimal(0));
const max = (a, b) => (D(a).greaterThan(D(b)) ? D(a) : D(b));
const min = (a, b) => (D(a).lessThan(D(b)) ? D(a) : D(b));
const toFixed = (v, d = 2) => round(v, d).toFixed(d);

module.exports = { Decimal, D, ZERO, round, sum, max, min, toFixed };
