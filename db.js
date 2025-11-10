// db.js
const { Pool } = require('pg');

// Logika BARU:
// Cek jika DATABASE_URL (dari Railway) ada.
// Jika tidak, baru pakai DATABASE_URL_LOCAL (dari .env di laptop)
const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URL_LOCAL;

// SSL (gembok) WAJIB ada jika kita pakai DATABASE_URL (Railway)
// Tapi SSL tidak ada di localhost.
const sslConfig = process.env.DATABASE_URL 
    ? { rejectUnauthorized: false } 
    : false;

// Jika connectionString masih kosong (error), beri tahu kami
if (!connectionString) {
    throw new Error('DATABASE_URL atau DATABASE_URL_LOCAL tidak ditemukan. Pastikan .env (lokal) atau Variables (Railway) sudah benar.');
}

const pool = new Pool({
    connectionString: connectionString,
    ssl: sslConfig
});

module.exports = {
    query: (text, params) => pool.query(text, params),
};