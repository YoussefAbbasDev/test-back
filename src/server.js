const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./database/prisma');
const app = require('./app');
const jobs = require('./jobs');

const server = app.listen(env.PORT, () => {
  logger.info(`SEEDA HRMS API listening on http://localhost:${env.PORT} (docs: /api/docs)`);
  if (process.env.DISABLE_JOBS !== 'true') jobs.start();
});

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
