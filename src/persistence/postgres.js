'use strict';

const { Pool, types } = require('pg');

// L'application utilise des identifiants bigint et des valeurs numeric qui restent
// très en dessous de Number.MAX_SAFE_INTEGER. Sans ces parseurs, node-postgres les
// renvoie sous forme de chaînes et le code métier existant ferait des concaténations.
types.setTypeParser(20, (value) => Number(value)); // int8 / bigint
types.setTypeParser(1700, (value) => Number(value)); // numeric

function positiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} doit être un entier positif`);
  return parsed;
}

// TLS vers Supabase. Avec DATABASE_SSL_CA (certificat racine Supabase, en PEM ou en
// base64) la connexion vérifie le certificat du serveur : protection contre
// l'interception. Sans ce certificat, on garde l'ancien comportement (chiffré mais
// non vérifié) pour ne pas couper le site, avec un avertissement dans les logs.
let sslWarned = false;
function sslConfig(env) {
  let ca = String(env.DATABASE_SSL_CA || '').trim();
  if (ca) {
    if (!ca.includes('BEGIN CERTIFICATE')) {
      try { ca = Buffer.from(ca, 'base64').toString('utf8'); } catch (_) { /* valeur invalide, contrôlée ci-dessous */ }
    }
    if (!ca.includes('BEGIN CERTIFICATE')) {
      throw new Error('DATABASE_SSL_CA doit contenir un certificat PEM (ou son encodage base64)');
    }
    return { ca, rejectUnauthorized: true };
  }
  if (!sslWarned) {
    sslWarned = true;
    console.warn('[sécurité] DATABASE_SSL_CA absent : le certificat de la base n\'est pas vérifié. Voir .env.example.');
  }
  return { rejectUnauthorized: false };
}

function postgresConfig(env = process.env) {
  // Les interfaces de déploiement copient parfois la valeur avec des guillemets
  // ou avec le nom de variable (`DATABASE_URL=postgresql://...`).
  let connectionString = String(env.DATABASE_URL || '').trim();
  connectionString = connectionString.replace(/^DATABASE_URL\s*=\s*/i, '').trim();
  connectionString = connectionString.replace(/^("|')|("|')$/g, '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL est obligatoire pour utiliser PostgreSQL/Supabase');
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (_) {
    throw new Error('DATABASE_URL doit être une URL PostgreSQL valide');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL doit utiliser le protocole postgres:// ou postgresql://');
  }

  // node-postgres peut laisser `sslmode=require` de l'URI remplacer l'objet
  // SSL fourni par le code. On le retire de l'URI : l'option ci-dessous reste
  // la source unique de vérité pour le TLS du pooler Supabase.
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('sslrootcert');
  const normalizedConnectionString = parsed.toString();

  return {
    connectionString: normalizedConnectionString,
    ssl: sslConfig(env),
    // Supabase recommande une connexion applicative très petite avec son pooler
    // transactionnel. La valeur reste configurable pour un serveur persistant.
    max: positiveInt(env.DATABASE_POOL_MAX, 1, 'DATABASE_POOL_MAX'),
    idleTimeoutMillis: positiveInt(env.DATABASE_IDLE_TIMEOUT_MS, 5000, 'DATABASE_IDLE_TIMEOUT_MS'),
    connectionTimeoutMillis: positiveInt(env.DATABASE_CONNECT_TIMEOUT_MS, 10000, 'DATABASE_CONNECT_TIMEOUT_MS'),
    application_name: env.DATABASE_APPLICATION_NAME || 'portail-scolaire',
    allowExitOnIdle: true,
  };
}

class PostgresDatabase {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('Un exécuteur PostgreSQL compatible avec node-postgres est requis');
    }
    this.pool = pool;
    this.driver = 'postgres';
  }

  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  async many(text, params = []) {
    const result = await this.query(text, params);
    return result.rows;
  }

  async maybeOne(text, params = []) {
    const result = await this.query(text, params);
    if (result.rows.length > 1) throw new Error(`Requête attendue sur 0 ou 1 ligne, ${result.rows.length} reçues`);
    return result.rows[0];
  }

  async one(text, params = []) {
    const row = await this.maybeOne(text, params);
    if (!row) throw new Error('Requête attendue sur exactement 1 ligne, aucune reçue');
    return row;
  }

  async execute(text, params = []) {
    const result = await this.query(text, params);
    return { rowCount: result.rowCount, rows: result.rows };
  }

  async transaction(work) {
    if (typeof this.pool.connect !== 'function') {
      throw new Error('Les transactions exigent un pool PostgreSQL avec connect()');
    }
    const client = await this.pool.connect();
    const tx = new PostgresTransaction(client);
    try {
      await client.query('BEGIN');
      const value = await work(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* conserver l'erreur initiale */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async healthcheck() {
    const result = await this.query('SELECT 1 AS ok');
    return result.rows[0] && Number(result.rows[0].ok) === 1;
  }

  async close() {
    await this.pool.end();
  }
}

class PostgresTransaction extends PostgresDatabase {
  constructor(client) {
    super(client);
  }

  async transaction(work) {
    // Un appel imbriqué participe à la transaction courante. Les services ne doivent
    // donc jamais ouvrir un second pool pendant une opération atomique.
    return work(this);
  }

  async close() {
    throw new Error('La fermeture d’une transaction est gérée par le pool');
  }
}

function createPostgresDatabase(options = {}) {
  const pool = options.pool || new Pool(options.config || postgresConfig(options.env));
  return new PostgresDatabase(pool);
}

module.exports = { sslConfig, PostgresDatabase, createPostgresDatabase, postgresConfig };
