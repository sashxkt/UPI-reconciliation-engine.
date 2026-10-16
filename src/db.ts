import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config';

// pg hands back bigint columns as strings, since they can be larger than a JS
// number. Our ids and paise amounts will never get close to 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

// Keep `date` columns as plain 'YYYY-MM-DD' strings instead of local-midnight Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Drops everything and loads db/schema.sql again. Only for dev, tests and the simulator.
export async function resetDatabase() {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query('drop schema if exists public cascade; create schema public;');
  await pool.query(schema);
}
