const express = require('express');
const router = express.Router();
const db = require('../db');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middleware 'isUser'
const isUser = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Rute Halaman Daftar Kategori
router.get('/categories', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM categories ORDER BY name ASC');
        res.render('categories', { categories: result.rows });
    } catch (err) {
        console.error(err);
        res.send('Error memuat kategori');
    }
});

// RUTE UNTUK HALAMAN FILTER / PENCARIAN
router.get('/search', async (req, res) => {
    try {
        // 1. Ambil semua parameter filter dari URL
        const { q, category, min_price, max_price, sort } = req.query;
        
        // 2. Ambil semua kategori untuk ditampilkan di sidebar
        const categoriesResult = await db.query('SELECT * FROM categories ORDER BY name ASC');

        // 3. Mulai bangun Query SQL yang dinamis
        let baseQuery = 'SELECT * FROM products WHERE stock_quantity > 0 AND is_archived = FALSE';
        const queryParams = [];
        let paramCount = 1;

        // --- Filter 1: Pencarian Nama ---
        if (q) {
            baseQuery += ` AND name ILIKE $${paramCount}`;
            queryParams.push(`%${q}%`);
            paramCount++;
        }

        // --- Filter 2: Kategori (Checkbox) ---
        if (category) {
            // Jika 'category' adalah array (banyak checkbox), gunakan 'ANY'
            if (Array.isArray(category)) {
                baseQuery += ` AND category_id = ANY($${paramCount}::int[])`;
                queryParams.push(category);
                paramCount++;
            } 
            // Jika 'category' hanya satu
            else if (category) {
                baseQuery += ` AND category_id = $${paramCount}`;
                queryParams.push(category);
                paramCount++;
            }
        }

        // --- Filter 3: Rentang Harga ---
        if (min_price) {
            baseQuery += ` AND price >= $${paramCount}`;
            queryParams.push(min_price);
            paramCount++;
        }
        if (max_price) {
            baseQuery += ` AND price <= $${paramCount}`;
            queryParams.push(max_price);
            paramCount++;
        }

        // --- Logika Sortir ---
        if (sort === 'price_desc') {
            baseQuery += ' ORDER BY price DESC'; // Termahal
        } else if (sort === 'price_asc') {
            baseQuery += ' ORDER BY price ASC'; // Termurah
        } else {
            baseQuery += ' ORDER BY created_at DESC'; // Default: Terbaru
        }

        // 4. Jalankan query
        const productsResult = await db.query(baseQuery, queryParams);

        // 5. Render halaman 'search.ejs' yang baru
        res.render('search', {
            products: productsResult.rows,
            categories: categoriesResult.rows,
            query: req.query // Kirim semua parameter query lama ke view
        });

    } catch (err) {
        console.error('Error di halaman search:', err);
        res.send('Error memuat halaman pencarian');
    }
});

// Rute Halaman Utama (Homepage)
router.get('/', async (req, res) => {
    try {
        // [FIX] Ambil 'search' dari res.locals (Middleware global di index.js)
        const { search } = res.locals; 

        let baseQuery = 'SELECT * FROM products WHERE stock_quantity > 0 AND is_archived = FALSE';
        const queryParams = [];

        if (search) {
            baseQuery += ' AND name ILIKE $1'; 
            queryParams.push(`%${search}%`);
        }
        baseQuery += ' ORDER BY created_at DESC';
        
        const result = await db.query(baseQuery, queryParams);

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

// Rute Keranjang (Cart)
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

// Rute Tambah ke Keranjang
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

// Rute Hapus dari Keranjang
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

// Rute Checkout Stripe
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