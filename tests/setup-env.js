// Point every test at the dedicated test database before any module reads DATABASE_URL.
require('dotenv').config();

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required to run tests');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.DISABLE_JOBS = 'true';
