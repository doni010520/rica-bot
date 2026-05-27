/**
 * src/lib/db.ts
 * Pool Postgres singleton com health check.
 */

import { Pool } from 'pg'
import { env } from './env.js'
import { logger } from '../observability/logger.js'

let _pool: Pool | null = null

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    _pool.on('error', (err) => {
      logger.error({ err }, 'Postgres pool: erro inesperado')
    })
  }
  return _pool
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    const pool = getPool()
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
