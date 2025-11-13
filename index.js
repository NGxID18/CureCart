require('dotenv').config();

// Impor alat-alat
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db'); 

const pgSession = require('connect-pg-simple')(session);
const pool = db.pool; 
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ----- DEBUGGING DEPLOY (Boleh dihapus nanti) -----
console.log('----- DEBUGGING DEPLOY -----');
console.log('Nilai NODE_ENV adalah:', process.env.NODE_ENV);
console.log('----------------------------');
// ---------------------------------------------

// Inisialisasi aplikasi Express
const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// ----- MIDDLEWARE -----

// 1. Atur EJS sebagai 'view engine'
app.set('view engine', 'ejs');

// Rute Webhook Stripe (HARUS SEBELUM 'urlencoded')
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

        // Tangani event 'checkout.session.completed'
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const orderId = session.metadata.order_id;
            const userId = session.metadata.user_id;

            try {
                console.log(`[Webhook ${orderId}] Langkah 1: Pembayaran diterima. Meng-update status order...`);
                await db.query(
                    'UPDATE orders SET status = $1 WHERE id = $2 AND user_id = $3',
                    ['Paid', orderId, userId]
                );
                console.log(`[Webhook ${orderId}] Langkah 2: Status order di-update.`);
                
                console.log(`[Webhook ${orderId}] Langkah 3: Mengambil order items...`);
                const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
                console.log(`[Webhook ${orderId}] Langkah 4: Ditemukan ${itemsResult.rows.length} item.`);
                
                for (const item of itemsResult.rows) {
                    console.log(`[Webhook ${orderId}] Langkah 5: Mengurangi stok untuk product ${item.product_id} (jumlah ${item.quantity})...`);
                    await db.query(
                        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                        [item.quantity, item.product_id]
                    );
                }
                console.log(`[Webhook ${orderId}] Langkah 6: Stok untuk Order ${orderId} telah dikurangi.`);
            } catch (dbErr) {
                console.error(`[Webhook ${orderId}] FATAL ERROR SAAT MEMPROSES PEMBAYARAN:`, dbErr);
                return res.status(500).send('Database error');
            }
        }
        res.status(200).send();
    }
);

// 2. Middleware untuk membaca data form (req.body)
app.use(express.urlencoded({ extended: true }));

// [BARU] Sajikan file statis dari folder 'public' (Untuk CSS Kustom)
app.use(express.static('public'));

// 3. Konfigurasi Session (Production-Ready dengan PG Store)
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
    next();
});

// ----- AKHIR MIDDLEWARE -----


// ----- FUNGSI MIDDLEWARE "SATPAM" -----
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.is_admin) {
        next();
    } else {
        res.redirect('/');
    }
};

const isUser = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};


// ----- RUTE (Routes) -----

// [PERUBAHAN UTAMA] Rute Homepage dengan Logika Pencarian
app.get('/', async (req, res) => {
    try {
        // Ambil query 'search' dari URL (e.g., /?search=stetoskop)
        const { search } = req.query;

        // Siapkan query dasar
        let baseQuery = 'SELECT * FROM products WHERE stock_quantity > 0 AND is_archived = FALSE';
        const queryParams = [];

        // Jika ada pencarian, modifikasi query-nya
        if (search) {
            // 'ILIKE' adalah 'LIKE' yang case-insensitive (khusus Postgres)
            // '$1' adalah placeholder untuk queryParams
            baseQuery += ' AND name ILIKE $1'; 
            queryParams.push(`%${search}%`); // '%' berarti 'cocok sebagian'
        }

        // Tambahkan urutan di akhir
        baseQuery += ' ORDER BY created_at DESC';

        // Jalankan query
        const result = await db.query(baseQuery, queryParams);

        // Kirim produk DAN istilah pencarian (agar form tetap terisi)
        res.render('index', { 
            products: result.rows,
            searchTerm: search || '' // Kirim 'search' atau string kosong
        });
    
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman toko.');
    }
});
// [AKHIR PERUBAHAN]

// Rute Halaman Detail Produk
app.get('/products/:id', async (req, res) => {
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

// ----- RUTE AUTENTIKASI (Tahap 3) -----
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
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

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
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

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});


// ----- RUTE KERANJANG & PEMBAYARAN -----
app.get('/cart', isUser, (req, res) => {
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

app.post('/cart/add/:id', isUser, async (req, res) => {
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

app.get('/cart/remove/:id', isUser, (req, res) => {
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
app.post('/create-checkout-session', isUser, async (req, res) => {
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
            success_url: `${process.env.YOUR_DOMAIN}/order/success`,
            cancel_url: `${process.env.YOUR_DOMAIN}/cart`,
        });
        res.json({ id: session.id });
    } catch (err) {
        console.error('Error saat create-checkout-session:', err);
        res.status(500).json({ error: 'Error membuat sesi checkout.' });
    }
});

// Rute Halaman Sukses Pembayaran
app.get('/order/success', isUser, (req, res) => {
    req.session.cart = [];
    req.session.save((err) => {
        if (err) {
            console.error('Error saat mengosongkan keranjang:', err);
        }
        res.render('order_success');
    });
});

// Rute Halaman Batal Pembayaran
app.get('/order/cancel', isUser, (req, res) => {
    res.render('order_cancel');
});

// Rute untuk MELIHAT Halaman Invoice (HTML)
app.get('/invoice/:id', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        const orderResult = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
        if (orderResult.rows.length === 0) {
            return res.send('Invoice tidak ditemukan atau bukan milik Anda.');
        }
        const itemsResult = await db.query(
            'SELECT p.name, oi.quantity, oi.price_at_purchase FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
            [id]
        );
        res.render('invoice', {
            order: orderResult.rows[0],
            items: itemsResult.rows
        });
    } catch (err) {
        console.error(err);
        res.send('Error memuat invoice.');
    }
});

// Rute untuk DOWNLOAD Invoice (PDF)
app.get('/invoice/:id/pdf', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        const orderResult = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
        if (orderResult.rows.length === 0) {
            return res.send('Invoice tidak ditemukan.');
        }
        const order = orderResult.rows[0];
        const itemsResult = await db.query(
            'SELECT p.name, oi.quantity, oi.price_at_purchase FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
            [id]
        );
        const items = itemsResult.rows;
        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.id}.pdf"`);
        doc.pipe(res);
        doc.fontSize(20).text(`Invoice #${order.id}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tanggal: ${new Date(order.created_at).toLocaleDateString('id-ID')}`);
        doc.text(`Status: ${order.status}`);
        doc.text(`Pelanggan: ${req.session.user.name} (${req.session.user.email})`);
        doc.moveDown();
        let y = doc.y;
        doc.font('Helvetica-Bold').text('Produk', 50, y);
        doc.text('Jumlah', 250, y);
        doc.text('Harga Satuan', 350, y);
        doc.text('Subtotal', 450, y, { align: 'right' });
        doc.moveDown();
        doc.font('Helvetica');
        for (const item of items) {
            y = doc.y;
            doc.text(item.name, 50, y);
            doc.text(item.quantity, 250, y);
            doc.text(`Rp ${item.price_at_purchase}`, 350, y);
            doc.text(`Rp ${item.quantity * item.price_at_purchase}`, 450, y, { align: 'right' });
            doc.moveDown();
        }
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(16).text(`Total: Rp ${order.total_amount}`, { align: 'right' });
        doc.end();
    } catch (err) {
        console.error(err);
        res.send('Error membuat PDF.');
    }
});

// ----- RUTE ADMIN (Tahap 4) -----
app.get('/admin/products', isAdmin, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM products ORDER BY id DESC');
        res.render('admin_products', { products: result.rows });
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman admin');
    }
});

app.get('/admin/products/new', isAdmin, (req, res) => {
    res.render('admin_product_form', {
        title: 'Tambah Produk Baru',
        product: null,
        url: '/admin/products/new'
    });
});

app.post('/admin/products/new', isAdmin, async (req, res) => {
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

app.get('/admin/products/edit/:id', isAdmin, async (req, res) => {
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

app.post('/admin/products/edit/:id', isAdmin, async (req, res) => {
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
app.post('/admin/products/delete/:id', isAdmin, async (req, res) => {
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
app.post('/admin/products/restore/:id', isAdmin, async (req, res) => {
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

// ----- AKHIR RUTE -----


// Mulai jalankan server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});