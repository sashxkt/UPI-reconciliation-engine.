import { pool, resetDatabase } from '../src/db';

await resetDatabase();
console.log('Database reset. Schema loaded from db/schema.sql.');
await pool.end();
