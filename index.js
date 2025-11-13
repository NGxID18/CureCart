require('dotenv').config();

// Impor alat-alat
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db'); // <-- Sekarang db diimpor SETELAH dotenv

const pgSession = require('connect-pg-simple')(session);
const pool = db.pool; // <-- Kita ambil pool dari db.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ----- DEBUGGING DEPLOY (Boleh dihapus nanti) -----
console.log('----- DEBUGGING DEPLOY -----');
console.log('Nilai NODE_ENV adalah:', process.env.NODE_ENV);
console.log('----------------------------');
// ---------------------------------------------

// Inisialisasi aplikasi Express
const app = express();
app.set('trust proxy', 1);
// Railway akan memberi tahu kita port mana yang harus dipakai via process.env.PORT
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// ----- MIDDLEWARE -----
// (Ini adalah 'otak' yang memproses request sebelum sampai ke Rute)

// 1. Atur EJS sebagai 'view engine'
app.set('view engine', 'ejs');

// ...
app.set('view engine', 'ejs');

app.post('/stripe-webhook', express.raw({type: 'application/json'}), 
    async (req, res) => {
        const sig = req.headers['stripe-signature'];

        let event;

        try {
            // Verifikasi bahwa event ini 100% dari Stripe
            event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        } catch (err) {
            console.log(`Webhook Error: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // Tangani event 'checkout.session.completed'
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;

            // Ambil ID Order kita dari metadata
            const orderId = session.metadata.order_id;
            const userId = session.metadata.user_id;

            try {
                // 1. Update status order menjadi 'Paid'
                await db.query(
                    'UPDATE orders SET status = $1 WHERE id = $2 AND user_id = $3',
                    ['Paid', orderId, userId]
                );
                
                // 2. Ambil data keranjang (LAGI) untuk mengurangi stok
                //    (Cara aman: Ambil item dari Stripe, bukan session)
                const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
                
                // 3. Ambil data keranjang DARI DATABASE KITA (Ini lebih aman)
                //    Kita perlu tahu ID produknya, bukan cuma nama.
                //    Ah, kita tidak menyimpan item di DB saat 'Pending'.
                //    Ini masalah.

                // --- PERBAIKAN ALUR (di Langkah 4) ---
                // Kita HARUS menyimpan order_items saat 'Pending' juga.

                // --- ASUMSIKAN KITA SUDAH UBAH LANGKAH 4 (Lihat di bawah) ---
                
                // 3. Kurangi Stok
                const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
                for (const item of itemsResult.rows) {
                    await db.query(
                        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                        [item.quantity, item.product_id]
                    );
                }

                // 4. Kosongkan keranjang session
                //    (Kita tidak bisa akses req.session di sini, 
                //     jadi kita kosongkan saat user mengunjungi /order/success)


                console.log(`Order ${orderId} telah berhasil dibayar.`);

            } catch (dbErr) {
                console.error('Error saat update database post-payment:', dbErr);
            }
        }

        // Kembalikan respons 200 OK ke Stripe
        res.status(200).send();
    }
);

// 2. Middleware untuk membaca data form (req.body)
app.use(express.urlencoded({ extended: true }));

// 3. Konfigurasi Session (Production-Ready dengan PG Store)
const sessionStore = new pgSession({
    pool: pool, // Gunakan pool koneksi kita
    tableName: 'user_sessions' // Cocokkan dengan nama tabel di Langkah 2
});

app.use(session({
    store: sessionStore, // <-- Kunci utamanya di sini
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // Kita ubah ke false (best practice)
    cookie: {
        secure: isProduction,
        httpOnly: true, // Mencegah XSS
        maxAge: 30 * 24 * 60 * 60 * 1000 // Cookie 30 hari
    }
}));

// 4. Middleware kustom...
// Tambahkan isProduction ke 'locals' agar EJS tahu
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.isProduction = isProduction;
    res.locals.stripePublicKey = process.env.STRIPE_PUBLISHABLE_KEY;
    next();
});

// ----- AKHIR MIDDLEWARE -----


// ----- FUNGSI MIDDLEWARE "SATPAM" -----

// Fungsi Middleware untuk Cek Admin
const isAdmin = (req, res, next) => {
    // Cek jika user login DAN user adalah admin
    if (req.session.user && req.session.user.is_admin) {
        // Jika ya, izinkan lanjut
        next();
    } else {
        // Jika tidak, tendang ke halaman utama
        res.redirect('/');
    }
};

// Fungsi Middleware untuk Cek Login (Pelanggan)
const isUser = (req, res, next) => {
    if (req.session.user) {
        // Jika user login (admin atau bukan), izinkan lanjut
        next();
    } else {
        // Jika belum login, tendang ke halaman login
        res.redirect('/login');
    }
};


// ----- RUTE (Routes) -----

// Rute Halaman Utama (Homepage) - Etalase (Tahap 5)
app.get('/', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM products WHERE stock_quantity > 0 AND is_archived = FALSE ORDER BY created_at DESC',
        );

        res.render('index', { products: result.rows });
    
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman toko.');
    }
});

// Rute Halaman Detail Produk
app.get('/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // GANTI QUERY INI:
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

// Rute untuk Halaman Login (GET)
app.get('/login', (req, res) => {
    res.render('login'); // Render file views/login.ejs
});

// Logika Login (POST)
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
            // Hanya redirect SETELAH session 100% tersimpan
            res.redirect('/');
        });

    } catch (err) {
        console.error(err);
        res.send('Error: Terjadi kesalahan.');
    }
});

// Rute untuk Halaman Registrasi (GET)
app.get('/register', (req, res) => {
    res.render('register'); // Render file views/register.ejs
});

// Logika Registrasi (POST)
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
            // Hanya redirect SETELAH session 100% tersimpan
            res.redirect('/');
        });

    } catch (err) {
        console.error(err);
        res.send('Error: Gagal mendaftar. Email mungkin sudah terpakai.');
    }
});

// Logika Logout (POST)
app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});


// ----- RUTE KERANJANG (Tahap 5) -----

// Rute untuk MELIHAT Halaman Keranjang
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

// Rute untuk MENAMBAH produk ke keranjang
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

        const itemIndex = req.session.cart.findIndex(item => item.id === product.id);

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
app.get('/cart/remove/:id', isUser, (req, res) => {
    const { id } = req.params;
    
    if (req.session.cart) {
        // Cari index item di keranjang
        const itemIndex = req.session.cart.findIndex(item => item.id == id);
        
        if (itemIndex > -1) {
            // Hapus item dari array
            req.session.cart.splice(itemIndex, 1);
        }
    }
    // Arahkan kembali ke halaman keranjang
    res.redirect('/cart');
});

// Rute untuk MEMBUAT SESI CHECKOUT STRIPE
app.post('/create-checkout-session', isUser, async (req, res) => {
    try {
        const cart = req.session.cart || [];
        const userId = req.session.user.id;
        const userEmail = req.session.user.email; // Kita butuh email untuk Stripe

        if (cart.length === 0) {
            return res.status(400).json({ error: 'Keranjang Anda kosong.' });
        }

        // --- Alur Baru: Buat Order 'Pending' DULU ---
        let total = 0;
        cart.forEach(item => {
            total += item.price * item.quantity;
        });

        // 1. Buat 'Order' baru di DB dengan status 'Pending'
        const orderResult = await db.query(
            'INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, $3) RETURNING id',
            [userId, total, 'Pending']
        );
        const newOrderId = orderResult.rows[0].id;

        // 2. Format item untuk API Stripe
        const line_items = cart.map(item => {
            return {
                price_data: {
                    currency: 'idr', // Stripe mendukung IDR
                    product_data: {
                        name: item.name,
                    },
                    unit_amount: item.price * 100, // Harga dalam SEN
                },
                quantity: item.quantity,
            };
        });

        // 3. Buat Sesi Pembayaran Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'], // 'card' mencakup Visa, Mastercard
            line_items: line_items,
            mode: 'payment',
            customer_email: userEmail,
            
            // [PENTING] Kirim ID Order kita ke Stripe, agar webhook tahu
            metadata: {
                order_id: newOrderId,
                user_id: userId
            },

            // URL tujuan setelah bayar/batal
            success_url: `${process.env.YOUR_DOMAIN || 'http://localhost:3000'}/order/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.YOUR_DOMAIN || 'http://localhost:3000'}/order/cancel`,
        });

        // 4. Kirim ID Sesi Stripe kembali ke klien
        res.json({ id: session.id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error membuat sesi checkout.' });
    }
});

// Rute untuk MELIHAT Halaman Invoice (HTML)
app.get('/invoice/:id', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Query untuk ambil data order
        const orderResult = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
        
        if (orderResult.rows.length === 0) {
            return res.send('Invoice tidak ditemukan atau bukan milik Anda.');
        }

        // Query untuk ambil data item-itemnya
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
        
        // Ambil data (Validasi user lagi)
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

        // ----- MULAI BUAT PDF -----
        const doc = new PDFDocument({ margin: 50 });

        // Atur header agar browser tahu ini adalah file PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.id}.pdf"`);

        // Salurkan output PDF langsung ke 'response'
        doc.pipe(res);

        // Tambahkan konten ke PDF
        doc.fontSize(20).text(`Invoice #${order.id}`, { align: 'center' });
        doc.moveDown();
        
        doc.fontSize(12).text(`Tanggal: ${new Date(order.created_at).toLocaleDateString('id-ID')}`);
        doc.text(`Status: ${order.status}`);
        doc.text(`Pelanggan: ${req.session.user.name} (${req.session.user.email})`);
        doc.moveDown();

        // Buat tabel (manual)
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

        // Selesaikan PDF
        doc.end();

    } catch (err) {
        console.error(err);
        res.send('Error membuat PDF.');
    }
});

// ----- RUTE ADMIN (Tahap 4) -----

// TAMPILKAN SEMUA PRODUK (READ)
app.get('/admin/products', isAdmin, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM products ORDER BY id DESC');
        res.render('admin_products', { products: result.rows });
    } catch (err) {
        console.error(err);
        res.send('Error memuat halaman admin');
    }
});

// TAMPILKAN FORM TAMBAH PRODUK BARU (CREATE - Bagian 1)
app.get('/admin/products/new', isAdmin, (req, res) => {
    res.render('admin_product_form', {
        title: 'Tambah Produk Baru',
        product: null,
        url: '/admin/products/new'
    });
});

// PROSES DATA PRODUK BARU (CREATE - Bagian 2)
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

// TAMPILKAN FORM EDIT PRODUK (UPDATE - Bagian 1)
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
    } catch (err)
 {
        console.error(err);
        res.send('Error memuat form edit');
    }
});

// PROSES DATA EDIT PRODUK (UPDATE - Bagian 2)
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

// ----- AKHIR RUTE -----


// Mulai jalankan server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});