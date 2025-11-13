const express = require('express');
const router = express.Router();
const db = require('../db');

// Middleware 'isAdmin' (kita salin ke sini)
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.is_admin) {
        next();
    } else {
        res.redirect('/');
    }
};

// TAMPILKAN SEMUA PRODUK (READ)
router.get('/products', isAdmin, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM products ORDER BY id DESC');
        res.render('admin_products', { products: result.rows });
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman admin');
    }
});

// TAMPILKAN FORM TAMBAH PRODUK BARU
router.get('/products/new', isAdmin, (req, res) => {
    res.render('admin_product_form', {
        title: 'Tambah Produk Baru',
        product: null,
        url: '/admin/products/new'
    });
});

// PROSES DATA PRODUK BARU
router.post('/products/new', isAdmin, async (req, res) => {
    try {
        const { name, description, price, stock_quantity, image_url } = req.body;
        await db.query(
            'INSERT INTO products (name, description, price, stock_quantity, image_url) VALUES ($1, $2, $3, $4, $5)',
            [name, description, price, stock_quantity, image_url]
        );
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.send('Error menambah produk');
    }
});

// TAMPILKAN FORM EDIT PRODUK
router.get('/products/edit/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('SELECT * FROM products WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.send('Produk tidak ditemukan');
        }
        res.render('admin_product_form', {
            title: 'Edit Produk',
            product: result.rows[0],
            url: `/admin/products/edit/${id}`
        });
    } catch (err) {
        console.error(err);
        res.send('Error memuat form edit');
    }
});

// PROSES DATA EDIT PRODUK
router.post('/products/edit/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, stock_quantity, image_url } = req.body;
        await db.query(
            'UPDATE products SET name = $1, description = $2, price = $3, stock_quantity = $4, image_url = $5 WHERE id = $6',
            [name, description, price, stock_quantity, image_url, id]
        );
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.send('Error meng-update produk');
    }
});

// PROSES HAPUS PRODUK (SOFT DELETE / ARCHIVE)
router.post('/products/delete/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query(
            'UPDATE products SET is_archived = TRUE WHERE id = $1',
            [id]
        );
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.send('Error meng-arsip produk.');
    }
});

// PROSES RESTORE PRODUK (Un-archive)
router.post('/products/restore/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query(
            'UPDATE products SET is_archived = FALSE WHERE id = $1',
            [id]
        );
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.send('Error memulihkan produk.');
    }
});

// TAMPILKAN SEMUA PESANAN (MANAJEMEN PESANAN)
router.get('/orders', isAdmin, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT orders.*, users.name AS customer_name 
             FROM orders 
             JOIN users ON orders.user_id = users.id 
             ORDER BY orders.created_at DESC`
        );
        res.render('admin_orders', { orders: result.rows });
    } catch (err) {
        console.error('Error memuat halaman manajemen pesanan:', err);
        res.send('Error memuat halaman manajemen pesanan');
    }
});

// KONFIRMASI / KIRIM PESANAN
router.post('/orders/ship/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query(
            "UPDATE orders SET status = 'Shipped' WHERE id = $1 AND status = 'Paid'",
            [id]
        );
        res.redirect('/admin/orders');
    } catch (err) {
        console.error('Error saat konfirmasi pesanan:', err);
        res.send('Error saat konfirmasi pesanan.');
    }
});

module.exports = router;