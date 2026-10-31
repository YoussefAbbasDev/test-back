const { PrismaClient } = require('@prisma/client');

const prisma = global.__seedaPrisma || new PrismaClient({ log: ['warn', 'error'] });
if (process.env.NODE_ENV !== 'production') global.__seedaPrisma = prisma;

module.exports = prisma;
