const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db'); // Kita pakai '../' untuk kembali satu folder

// Rute untuk Halaman Login (GET)
router.get('/login', (req, res) => {
    res.render('login');
});

// Logika Login (POST)
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.send('Error: Email atau password salah.');
        }
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.send('Error: Email atau password salah.');
        }
        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            is_admin: user.is_admin
        };
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.send('Error saat menyimpan session.');
            }
            res.redirect('/');
        });
    } catch (err) {
        console.error(err);
        res.send('Error: Terjadi kesalahan.');
    }
});

// Rute untuk Halaman Registrasi (GET)
router.get('/register', (req, res) => {
    res.render('register');
});

// Logika Registrasi (POST)
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *',
            [name, email, hashedPassword]
        );
        const newUser = result.rows[0];
        req.session.user = {
            id: newUser.id,
            name: newUser.name,
            email: newUser.email,
            is_admin: newUser.is_admin
        };
        req.session.save((err) => {
            if (err) {
                console.error('Session save error after register:', err);
                return res.send('Error saat menyimpan session setelah registrasi.');
            }
            res.redirect('/');
        });
    } catch (err) {
        console.error(err);
        res.send('Error: Gagal mendaftar. Email mungkin sudah terpakai.');
    }
});

// Logika Logout (POST)
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

module.exports = router; // Ekspor router