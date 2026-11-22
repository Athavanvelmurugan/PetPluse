const { Pool } = require('pg');
const config = require('../config');

const poolConfig = config.db.connectionString
  ? {
      connectionString: config.db.connectionString,
      ssl: config.db.ssl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      user: config.db.user,
      password: config.db.password,
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      ssl: config.db.ssl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle PostgreSQL client:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  withTenantContext: async (clinicId, isSuperAdmin = false, callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isSuperAdmin) {
        await client.query("SET LOCAL app.is_super_admin = 'true';");
      } else {
        await client.query("SET LOCAL app.clinic_id = $1;", [String(clinicId || '')]);
        await client.query("SET LOCAL app.is_super_admin = 'false';");
      }
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
  pool,
};

