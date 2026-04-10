const { Telegraf, Markup } = require('telegraf');
const midtransClient = require('midtrans-client');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DATA_PRODUK = './data/produk.json';
const DATA_CONFIG = './data/config.json';

// Helper Fungsi Data
const readData = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Load Config
let config = readData(DATA_CONFIG);

// Inisialisasi Midtrans
let snap = new midtransClient.Snap({
    isProduction: false, // Ubah ke true jika sudah Live
    serverKey: config.midtrans_key
});

// Inisialisasi Bot
const bot = new Telegraf(config.bot_token);

// ================= WEB ADMIN API =================

app.get('/api/admin/data', (req, res) => {
    res.json({ produk: readData(DATA_PRODUK), config: readData(DATA_CONFIG) });
});

app.post('/api/admin/add-product', (req, res) => {
    const { nama, harga } = req.body;
    let produk = readData(DATA_PRODUK);
    produk.push({ id: 'p' + Date.now(), nama, harga: parseInt(harga) });
    saveData(DATA_PRODUK, produk);
    res.json({ success: true });
});

app.delete('/api/admin/delete-product/:id', (req, res) => {
    let produk = readData(DATA_PRODUK).filter(p => p.id !== req.params.id);
    saveData(DATA_PRODUK, produk);
    res.json({ success: true });
});

app.post('/api/admin/update-config', (req, res) => {
    saveData(DATA_CONFIG, req.body);
    // Refresh variable lokal
    config = req.body;
    res.json({ success: true });
});

// ================= BOT LOGIC =================

bot.start((ctx) => {
    const produk = readData(DATA_PRODUK);
    if (produk.length === 0) return ctx.reply("Maaf, etalase sedang kosong.");

    const keyboard = produk.map(p => [
        Markup.button.callback(`${p.nama} - Rp${p.harga.toLocaleString()}`, `buy_${p.id}`)
    ]);

    ctx.reply(`Halo ${ctx.from.first_name}!\nSilahkan pilih produk yang ingin dibeli:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const item = readData(DATA_PRODUK).find(p => p.id === productId);
    if (!item) return ctx.reply('Produk tidak ditemukan.');

    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        let parameter = {
            "transaction_details": { "order_id": orderId, "gross_amount": item.harga },
            "customer_details": { "first_name": ctx.from.first_name, "user_id_tele": ctx.from.id }
        };

        const transaction = await snap.createTransaction(parameter);
        await ctx.reply(`Pesanan: ${item.nama}\nTotal: Rp${item.harga.toLocaleString()}\n\nSilahkan bayar melalui link berikut:`, 
            Markup.inlineKeyboard([[Markup.button.url('💳 Bayar Sekarang', transaction.redirect_url)]])
        );
    } catch (e) {
        ctx.reply("Gagal membuat transaksi. Pastikan Server Key Midtrans benar.");
    }
});

// ================= WEBHOOK MIDTRANS =================

app.post('/notification', async (req, res) => {
    try {
        const statusResponse = await snap.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const userId = orderId.split('-')[2];

        if (transactionStatus == 'settlement' || transactionStatus == 'capture') {
            await bot.telegram.sendMessage(userId, `✅ PEMBAYARAN BERHASIL!\n\nOrder ID: ${orderId}\nTerima kasih sudah membeli.`);
        }
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// ================= RUN SERVER =================
bot.launch();
app.listen(80, '0.0.0.0', () => console.log('Sistem Berjalan di Port 3000'));
