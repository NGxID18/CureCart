require('dotenv').config();

// Impor alat-alat
const express = require('express');
const session = require('express-session');
const db = require('./db');
const pgSession = require('connect-pg-simple')(session);
const pool = db.pool;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- Inisialisasi Aplikasi ---
const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// --- Impor Rute ---
const authRoutes = require('./routes/auth');
const shopRoutes = require('./routes/shop');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');

// ----- MIDDLEWARE -----

// 1. Atur EJS sebagai 'view engine'
app.set('view engine', 'ejs');

// 2. Rute Webhook Stripe (HARUS SEBELUM 'urlencoded' dan 'json')
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
app.post('/stripe-webhook', express.raw({type: 'application/json'}), 
    async (req, res) => {
        console.log('--- DEBUGGING WEBHOOK ---');
        console.log('Nilai Secret dari env:', process.env.STRIPE_WEBHOOK_SECRET);
        console.log('---------------------------');
        const sig = req.headers['stripe-signature'];
        let event;
        if (!endpointSecret) {
            console.error('FATAL: STRIPE_WEBHOOK_SECRET tidak terdefinisi!');
            return res.status(500).send('Webhook secret tidak dikonfigurasi.');
        }
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        } catch (err) {
            console.log(`Webhook Error: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const orderId = session.metadata.order_id;
            const userId = session.metadata.user_id;
            try {
                console.log(`[Webhook ${orderId}] Langkah 1: ...Meng-update status order...`);
                await db.query(
                    'UPDATE orders SET status = $1 WHERE id = $2 AND user_id = $3',
                    ['Paid', orderId, userId]
                );
                console.log(`[Webhook ${orderId}] Langkah 2: ...Mengambil order items...`);
                const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
                console.log(`[Webhook ${orderId}] Langkah 4: Ditemukan ${itemsResult.rows.length} item.`);
                for (const item of itemsResult.rows) {
                    console.log(`[Webhook ${orderId}] Langkah 5: Mengurangi stok untuk product ${item.product_id}...`);
                    await db.query(
                        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                        [item.quantity, item.product_id]
                    );
                }
                console.log(`[Webhook ${orderId}] Langkah 6: Stok telah dikurangi.`);
            } catch (dbErr) {
                console.error(`[Webhook ${orderId}] FATAL ERROR SAAT MEMPROSES PEMBAYARAN:`, dbErr);
                return res.status(500).send('Database error');
            }
        }
        res.status(200).send();
    }
);

// 3. Middleware Parser & Statis
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 4. Konfigurasi Session
const sessionStore = new pgSession({
    pool: pool, 
    tableName: 'user_sessions'
});
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, 
    cookie: {
        secure: isProduction,
        httpOnly: true, 
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 hari
    }
}));

// 4. Middleware kustom...
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.isProduction = isProduction;
    res.locals.stripePublicKey = process.env.STRIPE_PUBLISHABLE_KEY;
    res.locals.searchTerm = req.query.search || '';
    
    next();
});

// ----- PENGGUNAAN RUTE -----
// Gunakan file-file rute yang sudah kita impor

// Rute Autentikasi (Login, Register, Logout)
app.use('/', authRoutes);

// Rute Pesanan (Invoice, Histori, Batal)
app.use('/', orderRoutes);

// Rute Admin (/admin/products, /admin/orders)
app.use('/admin', adminRoutes);

// Rute Toko (Homepage, Detail, Keranjang, Checkout)
// Ini diletakkan terakhir agar rute '/' utamanya ditangkap
app.use('/', shopRoutes);

// ----- AKHIR RUTE -----

// Mulai jalankan server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});