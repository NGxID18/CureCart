const express = require('express');
const router = express.Router();
const db = require('../db');
const PDFDocument = require('pdfkit');

// Middleware 'isUser'
const isUser = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Rute Halaman Sukses Pembayaran
router.get('/order/success', isUser, (req, res) => {
    req.session.cart = [];
    req.session.save((err) => {
        if (err) {
            console.error('Error saat mengosongkan keranjang:', err);
        }
        res.render('order_success');
    });
});

// Rute Halaman Batal Pembayaran
router.get('/order/cancel', isUser, async (req, res) => {
    try {
        const { order_id } = req.query;
        if (order_id) {
            await db.query('DELETE FROM order_items WHERE order_id = $1', [order_id]);
            await db.query('DELETE FROM orders WHERE id = $1 AND user_id = $2 AND status = $3', [
                order_id,
                req.session.user.id,
                'Pending'
            ]);
        }
    } catch (err) {
        console.error('Error saat membersihkan order yang dibatalkan:', err);
    }
    res.render('order_cancel');
});

// TAMPILKAN HALAMAN "HISTORI PESANAN SAYA"
router.get('/my-orders', isUser, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
            [req.session.user.id]
        );
        res.render('my_orders', { orders: result.rows });
    } catch (err) {
        console.error('Error memuat halaman pesanan saya:', err);
        res.send('Error memuat halaman pesanan saya');
    }
});

// PROSES PEMBATALAN PESANAN OLEH PELANGGAN
router.post('/my-orders/cancel/:id', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.session.user.id;

        const itemsResult = await db.query(
            `SELECT oi.product_id, oi.quantity 
             FROM order_items oi
             JOIN orders o ON oi.order_id = o.id
             WHERE o.id = $1 AND o.user_id = $2 AND o.status = 'Paid'`,
            [id, userId]
        );
        
        if (itemsResult.rows.length > 0) {
            for (const item of itemsResult.rows) {
                await db.query(
                    'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
                    [item.quantity, item.product_id]
                );
            }
            await db.query(
                "UPDATE orders SET status = 'Cancelled_By_User' WHERE id = $1 AND user_id = $2 AND status = 'Paid'",
                [id, userId]
            );
        }
        res.redirect('/my-orders');
    } catch (err) {
        console.error('Error saat membatalkan pesanan:', err);
        res.send('Error saat membatalkan pesanan.');
    }
});

// Rute untuk MELIHAT Halaman Invoice (HTML)
router.get('/invoice/:id', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        const { from_checkout } = req.query; 

        if (from_checkout === 'true' && req.session.cart && req.session.cart.length > 0) {
            req.session.cart = [];
            req.session.save(); 
        }

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
            items: itemsResult.rows,
            from_checkout: from_checkout 
        });
    } catch (err) {
        console.error(err);
        res.send('Error memuat invoice.');
    }
});

// Rute untuk DOWNLOAD Invoice (PDF)
router.get('/invoice/:id/pdf', isUser, async (req, res) => {
    try {
        const { id } = req.params;
        const orderResult = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
        if (orderResult.rows.length === 0) { return res.send('Invoice tidak ditemukan.'); }
        const order = orderResult.rows[0];
        const itemsResult = await db.query('SELECT p.name, oi.quantity, oi.price_at_purchase FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1', [id]);
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
            doc.text(`Rp ${Number(item.price_at_purchase).toLocaleString('id-ID')}`, 350, y);
            doc.text(`Rp ${Number(item.quantity * item.price_at_purchase).toLocaleString('id-ID')}`, 450, y, { align: 'right' });
            doc.moveDown();
        }
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(16).text(`Total: Rp ${Number(order.total_amount).toLocaleString('id-ID')}`, { align: 'right' });
        doc.end();
    } catch (err) {
        console.error(err);
        res.send('Error membuat PDF.');
    }
});

module.exports = router;