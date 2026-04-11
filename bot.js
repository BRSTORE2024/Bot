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
    try { 
        return JSON.parse(fs.readFileSync(file, 'utf-8')); 
    } catch (e) { 
        return file.includes('produk') ? [] : {}; 
    }
};

const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let config = readData(DATA_CONFIG);

let coreApi = new midtransClient.CoreApi({
    isProduction: false,
    serverKey: config.midtrans_key || 'DUMMY',
    clientKey: config.client_key || 'DUMMY'
});

let bot = new Telegraf(config.bot_token || 'DUMMY');

// --- API ADMIN ---
app.get('/api/admin/data', (req, res) => {
    res.json({ produk: readData(DATA_PRODUK), config: readData(DATA_CONFIG) });
});

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
    coreApi = new midtransClient.CoreApi({ 
        isProduction: false, 
        serverKey: config.midtrans_key, 
        clientKey: config.client_key 
    });
    bot = new Telegraf(config.bot_token);
    res.json({ success: true });
});

// --- BOT LOGIC ---
bot.start((ctx) => {
    const p = readData(DATA_PRODUK);
    if (p.length === 0) return ctx.reply("Etalase kosong.");
    const btn = p.map(x => [Markup.button.callback(`${x.nama} - Rp${x.harga.toLocaleString()}`, `buy_${x.id}`)]);
    ctx.reply(`Pilih produk:`, Markup.inlineKeyboard(btn));
});

bot.action(/buy_(.+)/, async (ctx) => {
    const item = readData(DATA_PRODUK).find(x => x.id === ctx.match[1]);
    if (!item) return ctx.reply('Produk tidak ditemukan.');
    await ctx.answerCbQuery(`Generating QRIS...`);
    try {
        const orderId = `INV-${Date.now()}-${ctx.from.id}`;
        const resMid = await coreApi.charge({ 
            "payment_type": "gopay", 
            "transaction_details": { "order_id": orderId, "gross_amount": item.harga } 
        });
        const qrisUrl = resMid.actions.find(a => a.name === 'generate-qr-code').url;
        await ctx.replyWithPhoto(qrisUrl, {
            caption: `🔳 *PEMBAYARAN QRIS*\n📦 *${item.nama}*\n💰 *Rp ${item.harga.toLocaleString()}*\n🆔 \`${orderId}\`\n\n_Silahkan scan dan bayar_`,
            parse_mode: 'Markdown'
        });
    } catch (e) { 
        console.log(e);
        ctx.reply("Gagal membuat QRIS."); 
    }
});

// --- WEBHOOK ---
app.post('/notification', async (req, res) => {
    try {
        const s = await coreApi.transaction.notification(req.body);
        if (s.transaction_status === 'settlement' || s.transaction_status === 'capture') {
            const uid = s.order_id.split('-')[2];
            await bot.telegram.sendMessage(uid, `✅ *LUNAS*\nOrder: \`${s.order_id}\` sukses.`);
        }
    } catch (e) { 
        console.log("Webhook Error:", e.message); 
    }
    res.status(200).send('OK');
});

bot.launch().then(() => console.log("🤖 Bot Telegram Aktif!"));
app.listen(3000, '0.0.0.0', () => console.log(`🚀 Server Admin & Webhook Jalan di Port 3000`));
                       
