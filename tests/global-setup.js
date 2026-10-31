// Applies migrations to the test database once. Tests never reset data: every test file provisions its own
// uniquely-coded companies, which also exercises tenant isolation.
const { execSync } = require('child_process');
require('dotenv').config();

module.exports = () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } });
};
