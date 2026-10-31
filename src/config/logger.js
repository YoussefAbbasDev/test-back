const pino = require('pino');
const env = require('./env');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const usePretty = !env.isProd && !env.isTest && !isServerless && Boolean(process.stdout.isTTY);

let transport;
if (usePretty) {
  try {
    require.resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } };
  } catch {
    transport = undefined;
  }
}

const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password', '*.passwordHash', '*.iban', '*.kioskPin'],
    censor: '[REDACTED]',
  },
  transport,
});

module.exports = logger;
