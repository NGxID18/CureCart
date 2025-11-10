// db.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_LOCAL;

const sslConfig = process.env.DATABASE_URL 
    ? { rejectUnauthorized: false } 
    : false;

if (!connectionString) {
    throw new Error('DATABASE_URL atau DATABASE_URL_LOCAL tidak ditemukan.');
}

// 1. Buat pool
const pool = new Pool({
    connectionString: connectionString,
    ssl: sslConfig
});

// 2. Ekspor pool DAN fungsi query
module.exports = {
    pool: pool, // <-- TAMBAHAN BARU
    query: (text, params) => pool.query(text, params),
};