const express = require('express');
const router = express.Router();
const db = require('../db');

// Middleware Login
const isUser = (req, res, next) => {
    if (req.session.user) next();
    else res.redirect('/login');
};

// GET: Tampilkan Halaman Profil
router.get('/profile', isUser, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
        res.render('profile', { userProfile: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.send('Error memuat profil');
    }
});

// POST: Simpan Perubahan Profil
router.post('/profile', isUser, async (req, res) => {
    try {
        const { name, alamat, nomor_telepon, tanggal_lahir } = req.body;
        
        await db.query(
            `UPDATE users 
             SET name = $1, alamat = $2, nomor_telepon = $3, tanggal_lahir = $4 
             WHERE id = $5`,
            [name, alamat, nomor_telepon, tanggal_lahir, req.session.user.id]
        );

        req.session.user.name = name;
        req.session.save();

        res.redirect('/profile?success=true');
    } catch (err) {
        console.error(err);
        res.send('Error update profil');
    }
});

module.exports = router;