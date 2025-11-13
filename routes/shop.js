const express = require('express');
const router = express.Router();
const db = require('../db');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middleware 'isUser' (kita salin ke sini agar file ini mandiri)
const isUser = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Rute Halaman Utama (Homepage) dengan Logika Pencarian
router.get('/', async (req, res) => {
    try {
        // [FIX 1] Ambil 'search' dari res.locals (bukan req.query)
        const { search } = res.locals; 

        // Siapkan query dasar
        let baseQuery = 'SELECT * FROM products WHERE stock_quantity > 0 AND is_archived = FALSE';
        const queryParams = [];

        // [FIX 1] Logika ini sekarang akan berfungsi
        if (search) {
            // 'ILIKE' adalah 'LIKE' yang case-insensitive (khusus Postgres)
            baseQuery += ' AND name ILIKE $1'; 
            queryParams.push(`%${search}%`);
        }

        // Tambahkan urutan di akhir
        baseQuery += ' ORDER BY created_at DESC';

        // Jalankan query
        const result = await db.query(baseQuery, queryParams);

        // [FIX 1] Kita tidak perlu mengirim 'searchTerm' lagi, karena sudah global
        res.render('index', { 
            products: result.rows
        });
    
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman toko.');
    }
});

// Rute Halaman Detail Produk
router.get('/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            'SELECT * FROM products WHERE id = $1 AND is_archived = FALSE', 
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).send('Produk tidak ditemukan');
        }
        res.render('product_detail', { product: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman produk.');
    }
});

// Rute untuk MELIHAT Halaman Keranjang
router.get('/cart', isUser, (req, res) => {
    const cart = req.session.cart || [];
    let total = 0;
    cart.forEach(item => {
        total += item.price * item.quantity;
    });
    res.render('cart', {
        cart: cart,
        total: total
    });
});

// Rute untuk MENAMBAH produk ke keranjang
router.post('/cart/add/:id', isUser, async (req, res) => {
    const { id } = req.params;
    const quantity = parseInt(req.body.quantity, 10);
    if (isNaN(quantity) || quantity <= 0) {
        return res.redirect('/');
    }
    try {
        if (!req.session.cart) {
            req.session.cart = [];
        }
        const result = await db.query('SELECT * FROM products WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.send('Produk tidak ditemukan');
        }
        const product = result.rows[0];
        const itemIndex = req.session.cart.findIndex(item => item.id == product.id);
        if (itemIndex > -1) {
            req.session.cart[itemIndex].quantity += quantity;
        } else {
            req.session.cart.push({
                id: product.id,
                name: product.name,
                price: product.price,
                quantity: quantity
            });
        }
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.send('Error menambah ke keranjang');
    }
});

// Rute untuk MENGHAPUS item dari keranjang
router.get('/cart/remove/:id', isUser, (req, res) => {
    const { id } = req.params;
    if (req.session.cart) {
        const itemIndex = req.session.cart.findIndex(item => item.id == id);
        if (itemIndex > -1) {
            req.session.cart.splice(itemIndex, 1);
        }
    }
    res.redirect('/cart');
});

// Rute untuk MEMBUAT SESI CHECKOUT STRIPE
router.post('/create-checkout-session', isUser, async (req, res) => {
    try {
        const cart = req.session.cart || [];
        const userId = req.session.user.id;
        const userEmail = req.session.user.email;
        if (cart.length === 0) {
            return res.status(400).json({ error: 'Keranjang Anda kosong.' });
        }
        let total = 0;
        cart.forEach(item => {
            total += item.price * item.quantity;
        });

        const orderResult = await db.query(
            'INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, $3) RETURNING id',
            [userId, total, 'Pending']
        );
        const newOrderId = orderResult.rows[0].id;

        for (const item of cart) {
            await db.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)',
                [newOrderId, item.id, item.quantity, item.price]
            );
        }
        
        const line_items = cart.map(item => {
            return {
                price_data: {
                    currency: 'idr',
                    product_data: {
                        name: item.name,
                    },
                    unit_amount: item.price * 100, 
                },
                quantity: item.quantity,
            };
        });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: line_items,
            mode: 'payment',
            customer_email: userEmail,
            metadata: {
                order_id: newOrderId,
                user_id: userId
            },
            success_url: `${process.env.YOUR_DOMAIN}/invoice/${newOrderId}?from_checkout=true`,
            cancel_url: `${process.env.YOUR_DOMAIN}/order/cancel?order_id=${newOrderId}`,
        });
        res.json({ id: session.id });
    } catch (err) {
        console.error('Error saat create-checkout-session:', err);
        res.status(500).json({ error: 'Error membuat sesi checkout.' });
    }
});

module.exports = router;