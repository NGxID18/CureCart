const express = require('express');
const router = express.Router();
const db = require('../db');

// Middleware 'isAdmin'
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
router.get('/products/new', isAdmin, async (req, res) => {
    try {
        const categories = await db.query('SELECT * FROM categories ORDER BY name ASC');
        
        res.render('admin_product_form', {
            title: 'Tambah Produk Baru',
            product: null,
            categories: categories.rows,
            url: '/admin/products/new'
        });
    } catch (err) {
        console.error(err);
        res.send('Error memuat form tambah');
    }
});

// PROSES DATA PRODUK BARU
router.post('/products/new', isAdmin, async (req, res) => {
    try {
        const { name, description, price, stock_quantity, image_url, category_id } = req.body;
        
        await db.query(
            'INSERT INTO products (name, description, price, stock_quantity, image_url, category_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [name, description, price, stock_quantity, image_url, category_id || null]
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
        const productResult = await db.query('SELECT * FROM products WHERE id = $1', [id]);
        
        // [BARU] Ambil semua kategori untuk dropdown
        const categoriesResult = await db.query('SELECT * FROM categories ORDER BY name ASC');

        if (productResult.rows.length === 0) {
            return res.send('Produk tidak ditemukan');
        }

        res.render('admin_product_form', {
            title: 'Edit Produk',
            product: productResult.rows[0],
            categories: categoriesResult.rows, // [BARU] Kirim data kategori
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
        // [BARU] Tambahkan category_id
        const { name, description, price, stock_quantity, image_url, category_id } = req.body;
        
        await db.query(
            'UPDATE products SET name = $1, description = $2, price = $3, stock_quantity = $4, image_url = $5, category_id = $6 WHERE id = $7',
            [name, description, price, stock_quantity, image_url, category_id || null, id]
        );
        
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.send('Error meng-update produk');
    }
});

// PROSES HAPUS PRODUK (SOFT DELETE)
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

// PROSES RESTORE PRODUK
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

// MANAJEMEN PESANAN
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

// KONFIRMASI PESANAN
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