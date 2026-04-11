const { Telegraf, Markup } = require('telegraf');
const midtransClient = require('midtrans-client');
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

const DATA_PRODUK = './data/produk.json';
const DATA_CONFIG = './data/config.json';

const readData = (file) => {
    if (!fs.existsSync(file)) return file.includes('produk') ? [] : {};
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return file.includes('produk') ? [] : {}; }
};
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let config = readData(DATA_CONFIG);

let coreApi = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: config.midtrans_key || 'SB-Mid-server-xxx',
    clientKey: config.client_key || 'SB-Mid-client-xxx'
});

let bot = new Telegraf(config.bot_token || '12345:TOKEN_DUMMY');

// API ADMIN
app.get('/api/admin/data', (req, res) => res.json({ produk: readData(DATA_PRODUK), config: readData(DATA_CONFIG) }));

app.post('/api/admin/add-product', (req, res) => {
    let p = readData(DATA_PRODUK);
    p.push({ id: 'p' + Date.now(), nama: req.body.nama, harga: parseInt(req.body.harga) });
    saveData(DATA_PRODUK, p);
    res.json({ success: true });
});

app.delete('/api/admin/delete-product/:id', (req, res) => {
    let p = readData(DATA_PRODUK).filter(x => x.id !== req.params.id);
    saveData(DATA_PRODUK, p);
    res.json({ success: true });
});

app.post('/api/admin/update-config', (req, res) => {
    saveData(DATA_CONFIG, req.body);
    config = req.body;
    coreApi = new midtransClient.CoreApi({ isProduction: false, serverKey: config.midtrans_key, clientKey: config.client_key });
    bot = new Telegraf(config.bot_token);
    res.json({ success: true });
});

// BOT
bot.start((ctx) => {
    const p = readData(DATA_PRODUK);
    if (p.length === 0) return ctx.reply("Etalase kosong.");
    const btn = p.map(x => [Markup.button.callback(`${x.nama} - Rp${x.harga.toLocaleString()}`, `buy_${x.id}`)]);
    ctx.reply(`Pilih produk:`, Markup.inlineKeyboard(btn));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const item = readData(DATA_PRODUK).find(x => x.id === ctx.match[1]);
    if (!item) return ctx.reply('Produk hilang.');
    await ctx.answerCbQuery(`Generating QRIS...`);
    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        const resMid = await coreApi.charge({ "payment_type": "gopay", "transaction_details": { "order_id": orderId, "gross_amount": item.harga } });
        const qrisUrl = resMid.actions.find(a => a.name === 'generate-qr-code').url;
        await ctx.replyWithPhoto(qrisUrl, {
            caption: `🔳 *PEMBAYARAN QRIS*\n📦 *${item.nama}*\n💰 *Rp ${item.harga.toLocaleString()}*\n🆔 \`${orderId}\`\n\n_Scan & Bayar Otomatis_`,
            parse_mode: 'Markdown'
        });
    } catch (e) { ctx.reply("Gagal membuat QRIS."); }
});

// WEBHOOK
app.post('/notification', async (req, res) => {
    try {
        const s = await coreApi.transaction.notification(req.body);
        if (s.transaction_status == 'settlement' || s.transaction_status == 'capture') {
            const uid = s.order_id.split('-')[2];
            await bot.telegram.sendMessage(uid, `✅ *LUNAS*\nOrder ID: \`${s.order_id}\` telah sukses.`);
        }
    } catch (e) { console.log(e.message); }
    res.status(200).send('OK');
});

bot.launch().catch(e => console.log("Bot Error:", e.message));
app.listen(3000, '0.0.0.0', () => console.log(`🚀 Server Berjalan di Port 3000`));
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
    config = req.body;
    coreApi = new midtransClient.CoreApi({
        isProduction: false,
        serverKey: config.midtrans_key,
        clientKey: config.client_key
    });
    bot = new Telegraf(config.bot_token);
    res.json({ success: true });
});

// ================= BOT LOGIC =================

bot.start((ctx) => {
    const produk = readData(DATA_PRODUK);
    if (produk.length === 0) return ctx.reply("Etalase kosong.");
    const keyboard = produk.map(p => [Markup.button.callback(`${p.nama} - Rp${p.harga.toLocaleString()}`, `buy_${p.id}`)]);
    ctx.reply(`Halo ${ctx.from.first_name}!\nPilih produk untuk mendapatkan QRIS:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const item = readData(DATA_PRODUK).find(p => p.id === productId);
    if (!item) return ctx.reply('Produk tidak ditemukan.');

    await ctx.answerCbQuery(`Generating QRIS...`);

    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        let parameter = {
            "payment_type": "gopay",
            "transaction_details": {
                "order_id": orderId,
                "gross_amount": item.harga
            }
        };

        const response = await coreApi.charge(parameter);
        const qrisUrl = response.actions.find(a => a.name === 'generate-qr-code').url;

        await ctx.replyWithPhoto(qrisUrl, {
            caption: 
                `🔳 *PEMBAYARAN QRIS* 🔳\n` +
                `───────────────────────\n` +
                `📦 *Produk:* ${item.nama}\n` +
                `💰 *Total:* Rp ${item.harga.toLocaleString()}\n` +
                `🆔 *Order ID:* \`${orderId}\`\n` +
                `───────────────────────\n\n` +
                `✅ *Scan via:* GoPay, OVO, Dana, LinkAja, ShopeePay & M-Banking.\n\n` +
                `⏳ _Otomatis terkonfirmasi setelah bayar._`,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error(e);
        ctx.reply("Gagal membuat QRIS.");
    }
});

// ================= WEBHOOK =================

app.post('/notification', async (req, res) => {
    try {
        const statusResponse = await coreApi.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const userId = orderId.split('-')[2];

        if (transactionStatus == 'settlement' || transactionStatus == 'capture') {
            await bot.telegram.sendMessage(userId, `✅ *PEMBAYARAN BERHASIL!*\nPesanan \`${orderId}\` sukses.`);
        }
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send('Error');
    }
});

// Launch
bot.launch();
app.listen(3000, '0.0.0.0', () => console.log(`🚀 Server Berjalan!`));
bot.start((ctx) => {
    const produk = readData(DATA_PRODUK);
    if (produk.length === 0) return ctx.reply("Etalase kosong.");
    const keyboard = produk.map(p => [Markup.button.callback(`${p.nama} - Rp${p.harga.toLocaleString()}`, `buy_${p.id}`)]);
    ctx.reply(`Halo ${ctx.from.first_name}!\nPilih produk untuk mendapatkan QRIS:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const item = readData(DATA_PRODUK).find(p => p.id === productId);
    if (!item) return ctx.reply('Produk tidak ditemukan.');

    await ctx.answerCbQuery(`Generating QRIS...`);

    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        
        // Parameter Core API untuk QRIS
        let parameter = {
            "payment_type": "gopay", // Di Midtrans, QRIS biasanya melalui gopay/qris
            "transaction_details": {
                "order_id": orderId,
                "gross_amount": item.harga
            }
        };

        const response = await coreApi.charge(parameter);
        
        // Ambil URL QRIS dari respons (biasanya ada di actions[0].url)
        const qrisUrl = response.actions.find(a => a.name === 'generate-qr-code').url;

        await ctx.replyWithPhoto(qrisUrl, {
            caption: 
                `🔳 *QRIS PEMBAYARAN RESMI* 🔳\n` +
                `───────────────────────\n` +
                `📦 *Produk:* ${item.nama}\n` +
                `💰 *Total:* Rp ${item.harga.toLocaleString()}\n` +
                `🆔 *Order ID:* \`${orderId}\`\n` +
                `───────────────────────\n\n` +
                `✅ *Support Scan:* GoPay, OVO, Dana, LinkAja, ShopeePay, & Semua M-Banking.\n\n` +
                `⏳ _Silahkan selesaikan pembayaran, bot akan otomatis mengirimkan notifikasi jika sukses._`,
            parse_mode: 'Markdown'
        });

    } catch (e) {
        console.error(e);
        ctx.reply("Gagal membuat QRIS. Pastikan Server Key Sandbox kamu benar.");
    }
});

// ================= WEBHOOK (Sama seperti sebelumnya) =================

app.post('/notification', async (req, res) => {
    try {
        const statusResponse = await coreApi.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const userId = orderId.split('-')[2];

        if (transactionStatus == 'settlement') {
            await bot.telegram.sendMessage(userId, `✅ *PEMBAYARAN BERHASIL!*\nPesanan \`${orderId}\` sukses.`);
        }
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send('Error');
    }
});

bot.launch();
app.listen(3000, '0.0.0.0', () => console.log(`🚀 Server Core API Jalan!`));
});

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
    config = req.body;
    // Update Instance
    bot = new Telegraf(config.bot_token);
    snap = new midtransClient.Snap({
        isProduction: false,
        serverKey: config.midtrans_key
    });
    res.json({ success: true });
});

// ================= BOT LOGIC =================

bot.start((ctx) => {
    const produk = readData(DATA_PRODUK);
    if (produk.length === 0) return ctx.reply("Maaf, etalase sedang kosong.");

    const keyboard = produk.map(p => [
        Markup.button.callback(`${p.nama} - Rp${p.harga.toLocaleString()}`, `buy_${p.id}`)
    ]);

    ctx.reply(`Halo ${ctx.from.first_name}!\nSilahkan pilih produk:`, Markup.inlineKeyboard(keyboard));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const item = readData(DATA_PRODUK).find(p => p.id === productId);
    if (!item) return ctx.reply('Produk tidak ditemukan.');

    await ctx.answerCbQuery(`Menyiapkan QRIS untuk ${item.nama}...`);

    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        let parameter = {
            "transaction_details": { "order_id": orderId, "gross_amount": item.harga },
            "customer_details": { "first_name": ctx.from.first_name, "user_id_tele": ctx.from.id }
        };

        const transaction = await snap.createTransaction(parameter);
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(transaction.redirect_url)}`;

        await ctx.replyWithPhoto(qrCodeUrl, {
            caption: `📦 *Detail Pesanan*\n\n` +
                     `Produk: *${item.nama}*\n` +
                     `Total: *Rp${item.harga.toLocaleString()}*\n` +
                     `Order ID: \`${orderId}\`\n\n` +
                     `Silahkan scan QRIS di atas untuk membayar.`,
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('💳 Bayar via Web', transaction.redirect_url)]
            ])
        });
    } catch (e) {
        console.error(e);
        ctx.reply("Gagal membuat transaksi.");
    }
});

// ================= WEBHOOK MIDTRANS =================

app.post('/notification', async (req, res) => {
    console.log("🔔 Notifikasi Masuk...");
    try {
        const statusResponse = await snap.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const userId = orderId.split('-')[2];

        if (transactionStatus == 'settlement' || transactionStatus == 'capture') {
            await bot.telegram.sendMessage(userId, `✅ *PEMBAYARAN BERHASIL!*\n\nPesanan \`${orderId}\` telah lunas.`);
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(500).send('Error');
    }
});

// ================= RUN SERVER =================
bot.launch().catch(err => console.error("Bot launch error:", err));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server Jalan di Port ${PORT}`);
});
