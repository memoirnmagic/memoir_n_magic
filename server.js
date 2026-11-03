try { process.loadEnvFile(); } catch {}
const express = require('express'), Database = require('better-sqlite3'), multer = require('multer'),
  crypto = require('crypto'), path = require('path'), fs = require('fs'), ExcelJS = require('exceljs'),
  helmet = require('helmet'), rateLimit = require('express-rate-limit'), nodemailer = require('nodemailer');
const E = process.env, PORT = E.PORT || 3000, BASE = (E.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA = path.join(__dirname, 'data'), PUB = path.join(DATA, 'public'), PRIV = path.join(DATA, 'private');
[PUB, PRIV].forEach(d => fs.mkdirSync(d, { recursive: true }));
const db = new Database(path.join(DATA, 'mm.db'));
db.exec(`create table if not exists settings(k text primary key, v text);
create table if not exists samples(id integer primary key autoincrement, title text, description text, category text, date text, featured int default 0, cover text, pages text default '[]', pdf text);
create table if not exists messages(id integer primary key autoincrement, created text, name text, email text, body text);
create table if not exists orders(id text primary key, created text, data text, pricing text, payment_status text, order_status text, est_delivery text, tracking_no text default '', notes text default '', txn_id text, screenshot text, photos text, notify_log text default '[]');`);

const DEF = {
  pricing: { character: 60, creative: 100, premiumPerPage: 10, urgent: 50, hydDelivery: 80, outsideDelivery: 0,
    printPerPage: { '6x6': 50, '8x8': 50, A5: 50, A4: 50, custom: 50 } },
  payment: { bank: 'Account name: [ADD]\nAccount no: [ADD]\nIFSC: [ADD]\nBank: [ADD]', upi: '[ADD UPI ID]', qr: '',
    instructions: 'Pay the total shown, then upload your screenshot and transaction ID. We verify every payment by hand before work begins.' },
  contact: { whatsapp: '', instagram: 'memoir_and_magic', instagramUrl: '', igqr: '', logo: '', hours: 'Mon–Sat, 10:00 am – 7:00 pm IST' },
  leadDays: { standard: 14, urgent: 7 }
};
const get = k => { const r = db.prepare('select v from settings where k=?').get(k); return r ? JSON.parse(r.v) : DEF[k]; };
const set = (k, v) => db.prepare('insert into settings values(?,?) on conflict(k) do update set v=excluded.v').run(k, JSON.stringify(v));
const SECRET = E.SESSION_SECRET || get('secret') || (set('secret', crypto.randomBytes(32).toString('hex')), get('secret'));
const STATUSES = ['Order Received', 'Payment Verification', 'Story Development', 'Character Design', 'Illustration in Progress', 'Customer Approval', 'Printing', 'Quality Check', 'Dispatched', 'Delivered'];
const BIZ_EMAIL = E.BUSINESS_EMAIL || 'memoirnmagic@gmail.com';

// ---------- pricing (single source of truth; the site calls /api/price) ----------
function price(d) {
  const P = get('pricing'), L = get('leadDays'), n = +d.characters || 0, pg = +d.pages || 0;
  const physical = d.format !== 'pdf', hyd = /hyderabad/i.test(d.city || '');
  const r = { characters: n * P.character, printing: physical ? pg * (P.printPerPage[d.size] ?? P.printPerPage.custom) : 0,
    premium: physical && d.quality === 'premium' ? pg * P.premiumPerPage : 0, urgent: d.urgent ? P.urgent : 0,
    delivery: physical ? (hyd ? P.hydDelivery : P.outsideDelivery) : 0, creative: P.creative };
  r.deliveryToBeQuoted = physical && !!d.city && !hyd && !P.outsideDelivery;
  r.customSizeNote = d.size === 'custom';
  r.total = r.characters + r.printing + r.premium + r.urgent + r.delivery + r.creative;
  const dt = new Date(); dt.setDate(dt.getDate() + (d.urgent ? L.urgent : L.standard) + (physical ? 0 : -2));
  r.estDelivery = dt.toISOString().slice(0, 10);
  return r;
}
function validate(d) {
  const need = ['category', 'characters', 'story', 'pages', 'size', 'format', 'deliveryDate', 'name', 'phone', 'email'];
  for (const k of need) if (!String(d[k] ?? '').trim()) return `Please fill in: ${k}`;
  if (!(d.characters >= 1 && d.characters <= 12)) return 'Characters must be between 1 and 12';
  if (!Array.isArray(d.characterList) || d.characterList.length != d.characters || d.characterList.some(c => !String(c.name || '').trim())) return 'Please enter every character name';
  if (!(d.pages >= 4 && d.pages <= 100)) return 'Pages must be between 4 and 100';
  if (!/^\S+@\S+\.\S+$/.test(d.email)) return 'Enter a valid email address';
  if (String(d.phone).replace(/\D/g, '').length < 10) return 'Enter a valid phone number';
  if (d.format !== 'pdf') for (const k of ['address', 'city', 'state', 'pin']) if (!String(d[k] || '').trim()) return `Delivery ${k} is required for printed books`;
  if (d.pin && !/^\d{6}$/.test(d.pin)) return 'PIN code must be 6 digits';
  if (!d.consent) return 'Consent is required to submit photographs and details';
  return null;
}

// ---------- notifications (real integrations; do nothing unless configured) ----------
const mailer = E.SMTP_HOST ? nodemailer.createTransport({ host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, secure: +E.SMTP_PORT === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }) : null;
const waPhone = p => { const x = String(p).replace(/\D/g, ''); return x.length === 10 ? '91' + x : x; };
async function sendMail(to, subject, text) {
  if (!mailer) return 'email: not configured (set SMTP_* in .env)';
  try { await mailer.sendMail({ from: E.MAIL_FROM || `Memoir & Magic <${BIZ_EMAIL}>`, to, subject, text }); return `email to ${to}: sent`; }
  catch (e) { return `email to ${to}: FAILED ${e.message}`; }
}
async function sendWA(to, params) {
  if (!E.WA_TOKEN || !E.WA_PHONE_ID || !E.WA_TEMPLATE) return 'whatsapp: not configured (set WA_* in .env)';
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${E.WA_PHONE_ID}/messages`, { method: 'POST',
      headers: { Authorization: `Bearer ${E.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: waPhone(to), type: 'template',
        template: { name: E.WA_TEMPLATE, language: { code: E.WA_LANG || 'en' }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }] } }) });
    return r.ok ? `whatsapp to ${to}: sent` : `whatsapp to ${to}: FAILED ${r.status} ${(await r.text()).slice(0, 120)}`;
  } catch (e) { return `whatsapp to ${to}: FAILED ${e.message}`; }
}
async function notify(id, event) {
  const o = db.prepare('select * from orders where id=?').get(id), d = JSON.parse(o.data), p = JSON.parse(o.pricing);
  const link = `${BASE}/#track`, summary = `Order ${id}\nCustomer: ${d.name}\nCategory: ${d.category}\nTotal: ₹${p.total}\nPayment: ${o.payment_status}\nTrack: ${link}`;
  const log = [];
  log.push(await sendMail(BIZ_EMAIL, `[${event}] ${id} – ${d.name}`, `${summary}\n\nFull details:\n${JSON.stringify(d, null, 2)}`));
  log.push(await sendMail(d.email, `Memoir & Magic – ${event} (${id})`, `Hi ${d.name},\n\nThank you for choosing Memoir & Magic!\n\n${summary}\n\nWe verify payments manually and will update your tracking page as your story progresses.`));
  if (E.BUSINESS_WHATSAPP) log.push(await sendWA(E.BUSINESS_WHATSAPP, [id, d.name, d.category, '₹' + p.total]));
  else log.push('whatsapp to business: BUSINESS_WHATSAPP not set');
  log.push(await sendWA(d.phone, [id, d.name, d.category, '₹' + p.total]));
  const prev = JSON.parse(o.notify_log || '[]');
  db.prepare('update orders set notify_log=? where id=?').run(JSON.stringify([...prev, { at: new Date().toISOString(), event, log }]), id);
}

// ---------- app ----------
const app = express(); app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'"], objectSrc: ["'none'"] } } }));
app.use(express.json({ limit: '100kb' }));
const lim = (n, m) => rateLimit({ windowMs: m * 60000, limit: n, standardHeaders: true, legacyHeaders: false });
const ok = /\.(jpe?g|png|webp|pdf)$/i;
const up = dir => multer({ storage: multer.diskStorage({ destination: dir, filename: (q, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (q, f, cb) => cb(ok.test(f.originalname) && /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.mimetype) ? null : new Error('Only JPG, PNG, WEBP or PDF files are allowed'), true) });
const upPub = up(PUB), upPriv = up(PRIV);
const del = (dir, url) => { if (url) fs.rm(path.join(dir, path.basename(url)), () => {}); };

// admin auth: signed, expiring, httpOnly cookie
const sign = e => e + '.' + crypto.createHmac('sha256', SECRET).update('' + e).digest('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).filter(c => c[1]));
const isAdmin = req => { const t = cookie(req).mm_admin || ''; const [e] = t.split('.'); return !!e && +e > Date.now() && t.length === sign(e).length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(sign(e))); };
const admin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Please log in' });
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

app.post('/api/admin/login', lim(10, 15), (req, res) => {
  if (!E.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set in .env' });
  if (!crypto.timingSafeEqual(sha(req.body.password), sha(E.ADMIN_PASSWORD))) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `mm_admin=${sign(Date.now() + 8 * 3600e3)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${BASE.startsWith('https') ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (q, res) => { res.setHeader('Set-Cookie', 'mm_admin=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

// ---------- public API ----------
app.use('/media', express.static(PUB, { index: false }));
app.get('/api/config', (q, res) => res.json({ pricing: get('pricing'), payment: get('payment'), contact: get('contact'), statuses: STATUSES, lead: get('leadDays') }));
app.post('/api/price', (req, res) => res.json(price(req.body || {})));
app.get('/api/samples', (q, res) => res.json(db.prepare('select * from samples order by featured desc, date desc, id desc').all().map(s => ({ ...s, pages: JSON.parse(s.pages) }))));

app.post('/api/orders', lim(20, 60), upPriv.array('photos', 10), (req, res) => {
  const cleanup = () => (req.files || []).forEach(f => fs.rm(f.path, () => {}));
  let d; try { d = JSON.parse(req.body.data); } catch { cleanup(); return res.status(400).json({ error: 'Invalid order data' }); }
  const err = validate(d); if (err) { cleanup(); return res.status(400).json({ error: err }); }
  d.consentAt = new Date().toISOString();
  const id = 'MM-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  db.prepare('insert into orders(id,created,data,pricing,payment_status,order_status,est_delivery,photos) values(?,?,?,?,?,?,?,?)')
    .run(id, new Date().toISOString(), JSON.stringify(d), JSON.stringify(price(d)), 'Awaiting payment', 'Order Received', price(d).estDelivery, JSON.stringify((req.files || []).map(f => f.filename)));
  notify(id, 'New order').catch(() => {});
  res.json({ id, pricing: price(d) });
});
app.post('/api/orders/:id/payment', lim(20, 60), upPriv.single('screenshot'), (req, res) => {
  const o = db.prepare('select * from orders where id=?').get(req.params.id), d = o && JSON.parse(o.data);
  if (!o || d.email.toLowerCase() !== String(req.body.email || '').toLowerCase()) { if (req.file) fs.rm(req.file.path, () => {}); return res.status(404).json({ error: 'Order not found' }); }
  if (!req.file || !String(req.body.txn || '').trim()) { if (req.file) fs.rm(req.file.path, () => {}); return res.status(400).json({ error: 'Add your transaction ID and a payment screenshot' }); }
  db.prepare("update orders set txn_id=?, screenshot=?, payment_status='Submitted – awaiting verification', order_status='Payment Verification' where id=?").run(req.body.txn.trim().slice(0, 80), req.file.filename, o.id);
  notify(o.id, 'Payment submitted').catch(() => {});
  res.json({ ok: true });
});
app.post('/api/track', lim(30, 15), (req, res) => {
  const o = db.prepare('select * from orders where id=?').get(String(req.body.id || '').trim().toUpperCase()), c = String(req.body.contact || '').trim().toLowerCase();
  const d = o && JSON.parse(o.data), digits = c.replace(/\D/g, '');
  if (!o || !c || !(d.email.toLowerCase() === c || (digits.length >= 10 && d.phone.replace(/\D/g, '').slice(-10) === digits.slice(-10)))) return res.status(404).json({ error: 'We could not find an order with those details.' });
  const p = JSON.parse(o.pricing);
  res.json({ id: o.id, category: d.category, characters: d.characters, pages: d.pages, size: d.size, quality: d.quality, format: d.format, total: p.total, deliveryToBeQuoted: p.deliveryToBeQuoted,
    payment_status: o.payment_status, order_status: o.order_status, est_delivery: o.est_delivery, tracking_no: o.tracking_no });
});
app.post('/api/contact', lim(10, 60), async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || !message) return res.status(400).json({ error: 'Please fill in your name, a valid email and a message' });
  db.prepare('insert into messages(created,name,email,body) values(?,?,?,?)').run(new Date().toISOString(), name.slice(0, 100), email.slice(0, 120), message.slice(0, 3000));
  sendMail(BIZ_EMAIL, `Website enquiry from ${name}`, `${email}\n\n${message}`);
  res.json({ ok: true });
});

// ---------- admin API ----------
const A = express.Router(); A.use(admin); app.use('/api/admin', A);
const row = o => ({ ...o, data: JSON.parse(o.data), pricing: JSON.parse(o.pricing), photos: JSON.parse(o.photos || '[]'), notify_log: JSON.parse(o.notify_log || '[]') });
A.get('/stats', (q, res) => {
  const all = db.prepare('select * from orders').all().map(row), paid = all.filter(o => o.payment_status === 'Verified (paid)');
  const mon = new Date().toISOString().slice(0, 7);
  res.json({ total: all.length, fresh: all.filter(o => o.order_status === 'Order Received' && o.payment_status === 'Awaiting payment').length,
    pendingPayments: all.filter(o => o.payment_status.startsWith('Submitted')).length,
    inProgress: all.filter(o => ['Story Development', 'Character Design', 'Illustration in Progress', 'Customer Approval', 'Printing', 'Quality Check'].includes(o.order_status)).length,
    completed: all.filter(o => o.order_status === 'Delivered').length, dispatched: all.filter(o => o.order_status === 'Dispatched').length,
    sales: paid.reduce((s, o) => s + o.pricing.total, 0), monthSales: paid.filter(o => o.created.startsWith(mon)).reduce((s, o) => s + o.pricing.total, 0),
    messages: db.prepare('select * from messages order by id desc limit 50').all() });
});
A.get('/orders', (req, res) => {
  const f = req.query, q = (f.q || '').toLowerCase();
  res.json(db.prepare('select * from orders order by created desc').all().map(row).filter(o =>
    (!q || o.id.toLowerCase().includes(q) || o.data.name.toLowerCase().includes(q)) && (!f.category || o.data.category === f.category) &&
    (!f.payment || o.payment_status === f.payment) && (!f.status || o.order_status === f.status) && (!f.from || o.created.slice(0, 10) >= f.from) && (!f.to || o.created.slice(0, 10) <= f.to)));
});
A.get('/file/:name', (req, res) => res.sendFile(path.join(PRIV, path.basename(req.params.name))));
A.patch('/orders/:id', (req, res) => {
  const o = db.prepare('select * from orders where id=?').get(req.params.id); if (!o) return res.sendStatus(404);
  const b = req.body, pr = JSON.parse(o.pricing);
  if (b.delivery !== undefined && b.delivery !== '') { pr.total += +b.delivery - pr.delivery; pr.delivery = +b.delivery; pr.deliveryToBeQuoted = false; }
  db.prepare('update orders set payment_status=?, order_status=?, est_delivery=?, tracking_no=?, notes=?, pricing=? where id=?')
    .run(b.payment_status ?? o.payment_status, b.order_status ?? o.order_status, b.est_delivery ?? o.est_delivery, b.tracking_no ?? o.tracking_no, b.notes ?? o.notes, JSON.stringify(pr), o.id);
  res.json({ ok: true });
});
A.get('/export.xlsx', async (q, res) => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Orders');
  const cols = ['Order ID', 'Order date', 'Customer name', 'Email', 'Phone', 'Category', 'Character count', 'Character names', 'Page count', 'Book size', 'Print quality', 'Format', 'Delivery date', 'Delivery address', 'Character charges', 'Printing charges', 'Premium charges', 'Urgent charges', 'Delivery charges', 'Creative charges', 'Total amount', 'Payment status', 'Order status'];
  ws.columns = cols.map(h => ({ header: h, width: Math.max(14, h.length + 2) })); ws.getRow(1).font = { bold: true };
  db.prepare('select * from orders order by created').all().map(row).forEach(({ id, created, data: d, pricing: p, payment_status, order_status }) =>
    ws.addRow([id, created.slice(0, 10), d.name, d.email, d.phone, d.category, d.characters, d.characterList.map(c => c.name + (c.age ? ` (${c.age})` : '')).join(', '), d.pages, d.size, d.quality, d.format, d.deliveryDate,
      [d.address, d.city, d.state, d.pin].filter(Boolean).join(', '), p.characters, p.printing, p.premium, p.urgent, p.delivery, p.creative, p.total, payment_status, order_status]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="memoir-and-magic-orders.xlsx"');
  await wb.xlsx.write(res); res.end();
});
const sf = upPub.fields([{ name: 'cover', maxCount: 1 }, { name: 'pages', maxCount: 20 }, { name: 'pdf', maxCount: 1 }]);
const sampleSave = (req, res) => {
  const b = req.body, f = req.files || {}, id = req.params.id, old = id && db.prepare('select * from samples where id=?').get(id);
  if (!b.title || !['Children\'s Stories', 'Friendship Stories', 'Love Stories'].includes(b.category) || (!old && !f.cover)) return res.status(400).json({ error: 'Title, category and a cover image are required' });
  const cover = f.cover ? '/media/' + f.cover[0].filename : old?.cover, pdf = f.pdf ? '/media/' + f.pdf[0].filename : old?.pdf || null;
  let pages = old ? JSON.parse(old.pages) : [];
  if (b.clearPages === '1') { pages.forEach(p => del(PUB, p)); pages = []; }
  if (f.pages) pages = pages.concat(f.pages.map(x => '/media/' + x.filename));
  if (old && f.cover) del(PUB, old.cover); if (old && f.pdf) del(PUB, old.pdf);
  const v = [b.title, b.description || '', b.category, b.date || new Date().toISOString().slice(0, 10), b.featured === '1' ? 1 : 0, cover, JSON.stringify(pages), pdf];
  if (old) db.prepare('update samples set title=?,description=?,category=?,date=?,featured=?,cover=?,pages=?,pdf=? where id=?').run(...v, id);
  else db.prepare('insert into samples(title,description,category,date,featured,cover,pages,pdf) values(?,?,?,?,?,?,?,?)').run(...v);
  res.json({ ok: true });
};
A.post('/samples', sf, sampleSave); A.put('/samples/:id', sf, sampleSave);
A.delete('/samples/:id', (req, res) => { const s = db.prepare('select * from samples where id=?').get(req.params.id); if (s) { del(PUB, s.cover); del(PUB, s.pdf); JSON.parse(s.pages).forEach(p => del(PUB, p)); db.prepare('delete from samples where id=?').run(s.id); } res.json({ ok: true }); });
A.put('/settings', (req, res) => { for (const k of ['pricing', 'payment', 'contact', 'leadDays']) if (req.body[k]) set(k, { ...get(k), ...req.body[k], ...(k === 'pricing' ? { printPerPage: { ...get(k).printPerPage, ...req.body[k].printPerPage } } : {}) }); res.json({ ok: true }); });
A.post('/asset/:kind', upPub.single('file'), (req, res) => {
  const map = { qr: ['payment', 'qr'], logo: ['contact', 'logo'], igqr: ['contact', 'igqr'] }[req.params.kind];
  if (!map || !req.file) return res.status(400).json({ error: 'Choose an image' });
  const s = get(map[0]); del(PUB, s[map[1]]); s[map[1]] = '/media/' + req.file.filename; set(map[0], s); res.json({ ok: true });
});

app.use((err, q, res, n) => res.status(400).json({ error: err.message || 'Something went wrong' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.listen(PORT, () => console.log(`Memoir & Magic running at ${BASE}`));
