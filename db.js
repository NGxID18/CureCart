require('dotenv').config();
const { Pool } = require('pg');

// Cek jika kita di server (Railway) atau di lokal
const isProduction = process.env.NODE_ENV === 'production';

// Ambil URL koneksi
// Saat di Railway, dia akan ambil dari 'Variables'
// Saat di lokal, dia akan ambil dari file .env
const connectionString = isProduction 
    ? process.env.DATABASE_URL 
    : process.env.DATABASE_URL_LOCAL;

// Konfigurasi SSL (Wajib untuk Railway/Heroku)
const sslConfig = isProduction 
    ? { rejectUnauthorized: false } 
    : false;

const pool = new Pool({
    connectionString: connectionString,
    ssl: sslConfig
});

module.exports = {
    query: (text, params) => pool.query(text, params),
};