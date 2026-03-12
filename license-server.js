const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATABASE =====
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) DEFAULT 0,
      category VARCHAR(50) DEFAULT 'software',
      image_url TEXT,
      demo_url TEXT,
      github_url TEXT,
      features TEXT[],
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      license_key VARCHAR(64) UNIQUE NOT NULL,
      product_id INTEGER REFERENCES products(id),
      customer_name VARCHAR(100),
      customer_email VARCHAR(100),
      status VARCHAR(20) DEFAULT 'active',
      max_activations INTEGER DEFAULT 1,
      activations INTEGER DEFAULT 0,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      license_key VARCHAR(64),
      machine_id VARCHAR(200),
      activated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id),
      customer_name VARCHAR(100),
      customer_email VARCHAR(100),
      amount DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'pending',
      license_key VARCHAR(64),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Insert sample products if empty
  const check = await db.query('SELECT COUNT(*) FROM products');
  if (parseInt(check.rows[0].count) === 0) {
    await db.query(`
      INSERT INTO products (name, description, price, category, features) VALUES
      ('غزل عراقي - دردشة', 'موقع دردشة متكامل مع نظام إدارة وغرف متعددة', 99.00, 'chat', ARRAY['دردشة حية', 'غرف متعددة', 'نظام رتب', 'لوحة إدارة', 'رسائل خاصة']),
      ('نظام إدارة المستخدمين', 'نظام تسجيل دخول وإدارة مستخدمين متكامل', 49.00, 'system', ARRAY['تسجيل دخول', 'صلاحيات', 'لوحة تحكم'])
    `);
  }

  console.log('✅ Database ready');
}

// ===== ADMIN AUTH =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'hssiq-admin-2024';
function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) 
    return res.json({ ok: false, msg: 'غير مصرح' });
  next();
}

function generateLicenseKey() {
  const seg = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HSSIQ-${seg()}-${seg()}-${seg()}`;
}

// ===== PUBLIC API =====

// Get all active products (portfolio)
app.get('/api/products', async (req, res) => {
  const r = await db.query('SELECT * FROM products WHERE is_active=TRUE ORDER BY created_at DESC');
  res.json({ ok: true, products: r.rows });
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  const r = await db.query('SELECT * FROM products WHERE id=$1 AND is_active=TRUE', [req.params.id]);
  if (!r.rows.length) return res.json({ ok: false, msg: 'المنتج غير موجود' });
  res.json({ ok: true, product: r.rows[0] });
});

// Submit order (customer buys)
app.post('/api/orders', async (req, res) => {
  const { product_id, customer_name, customer_email, notes } = req.body;
  if (!product_id || !customer_name || !customer_email)
    return res.json({ ok: false, msg: 'بيانات ناقصة' });
  const prod = await db.query('SELECT * FROM products WHERE id=$1', [product_id]);
  if (!prod.rows.length) return res.json({ ok: false, msg: 'المنتج غير موجود' });
  const r = await db.query(
    'INSERT INTO orders (product_id,customer_name,customer_email,amount,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [product_id, customer_name, customer_email, prod.rows[0].price, notes || '']
  );
  res.json({ ok: true, order_id: r.rows[0].id, msg: 'تم إرسال طلبك! سيتم التواصل معك قريباً.' });
});

// Verify license key
app.post('/api/license/verify', async (req, res) => {
  const { license_key, machine_id } = req.body;
  if (!license_key) return res.json({ ok: false, msg: 'مفتاح الترخيص مطلوب' });
  const r = await db.query(
    'SELECT l.*, p.name as product_name FROM licenses l LEFT JOIN products p ON l.product_id=p.id WHERE l.license_key=$1',
    [license_key]
  );
  if (!r.rows.length) return res.json({ ok: false, msg: '❌ مفتاح الترخيص غير صحيح' });
  const lic = r.rows[0];
  if (lic.status !== 'active') return res.json({ ok: false, msg: '❌ الترخيص موقوف أو منتهي' });
  if (lic.expires_at && new Date(lic.expires_at) < new Date())
    return res.json({ ok: false, msg: '❌ انتهت صلاحية الترخيص' });
  
  // Check activation
  if (machine_id) {
    const existing = await db.query(
      'SELECT * FROM activations WHERE license_key=$1 AND machine_id=$2',
      [license_key, machine_id]
    );
    if (!existing.rows.length) {
      if (lic.activations >= lic.max_activations)
        return res.json({ ok: false, msg: `❌ تجاوزت الحد الأقصى للتفعيل (${lic.max_activations})` });
      await db.query('INSERT INTO activations (license_key,machine_id) VALUES ($1,$2)', [license_key, machine_id]);
      await db.query('UPDATE licenses SET activations=activations+1 WHERE license_key=$1', [license_key]);
    }
  }
  res.json({ ok: true, msg: '✅ الترخيص صحيح وفعال', license: {
    key: lic.license_key,
    product: lic.product_name,
    customer: lic.customer_name,
    status: lic.status,
    expires: lic.expires_at
  }});
});

// ===== ADMIN API =====

// Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [prods, lics, orders, active] = await Promise.all([
    db.query('SELECT COUNT(*) FROM products'),
    db.query('SELECT COUNT(*) FROM licenses'),
    db.query('SELECT COUNT(*) FROM orders'),
    db.query("SELECT COUNT(*) FROM licenses WHERE status='active'")
  ]);
  const revenue = await db.query("SELECT COALESCE(SUM(amount),0) as total FROM orders WHERE status='completed'");
  res.json({ ok: true, stats: {
    products: parseInt(prods.rows[0].count),
    licenses: parseInt(lics.rows[0].count),
    orders: parseInt(orders.rows[0].count),
    active_licenses: parseInt(active.rows[0].count),
    revenue: parseFloat(revenue.rows[0].total)
  }});
});

// Get all orders
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  const r = await db.query(`
    SELECT o.*, p.name as product_name 
    FROM orders o LEFT JOIN products p ON o.product_id=p.id 
    ORDER BY o.created_at DESC LIMIT 100
  `);
  res.json({ ok: true, orders: r.rows });
});

// Approve order + generate license
app.post('/api/admin/orders/approve', adminAuth, async (req, res) => {
  const { order_id, expires_days, max_activations } = req.body;
  const order = await db.query('SELECT * FROM orders WHERE id=$1', [order_id]);
  if (!order.rows.length) return res.json({ ok: false, msg: 'الطلب غير موجود' });
  const o = order.rows[0];
  const key = generateLicenseKey();
  const expires = expires_days ? new Date(Date.now() + expires_days * 86400000) : null;
  await db.query(
    'INSERT INTO licenses (license_key,product_id,customer_name,customer_email,max_activations,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [key, o.product_id, o.customer_name, o.customer_email, max_activations || 1, expires]
  );
  await db.query('UPDATE orders SET status=$1, license_key=$2 WHERE id=$3', ['completed', key, order_id]);
  res.json({ ok: true, license_key: key, msg: 'تمت الموافقة وتم إنشاء الترخيص' });
});

// Get all licenses
app.get('/api/admin/licenses', adminAuth, async (req, res) => {
  const r = await db.query(`
    SELECT l.*, p.name as product_name 
    FROM licenses l LEFT JOIN products p ON l.product_id=p.id 
    ORDER BY l.created_at DESC
  `);
  res.json({ ok: true, licenses: r.rows });
});

// Create license manually
app.post('/api/admin/licenses/create', adminAuth, async (req, res) => {
  const { product_id, customer_name, customer_email, expires_days, max_activations } = req.body;
  const key = generateLicenseKey();
  const expires = expires_days ? new Date(Date.now() + expires_days * 86400000) : null;
  await db.query(
    'INSERT INTO licenses (license_key,product_id,customer_name,customer_email,max_activations,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [key, product_id || null, customer_name || '', customer_email || '', max_activations || 1, expires]
  );
  res.json({ ok: true, license_key: key });
});

// Revoke license
app.post('/api/admin/licenses/revoke', adminAuth, async (req, res) => {
  await db.query("UPDATE licenses SET status='revoked' WHERE license_key=$1", [req.body.license_key]);
  res.json({ ok: true });
});

// Add/Edit product
app.post('/api/admin/products/add', adminAuth, async (req, res) => {
  const { name, description, price, category, image_url, demo_url, github_url, features } = req.body;
  if (!name) return res.json({ ok: false, msg: 'الاسم مطلوب' });
  const r = await db.query(
    'INSERT INTO products (name,description,price,category,image_url,demo_url,github_url,features) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [name, description || '', price || 0, category || 'software', image_url || null, demo_url || null, github_url || null, features || []]
  );
  res.json({ ok: true, id: r.rows[0].id });
});

app.post('/api/admin/products/edit', adminAuth, async (req, res) => {
  const { id, name, description, price, category, image_url, demo_url, github_url, features, is_active } = req.body;
  await db.query(
    'UPDATE products SET name=$1,description=$2,price=$3,category=$4,image_url=$5,demo_url=$6,github_url=$7,features=$8,is_active=$9 WHERE id=$10',
    [name, description, price, category, image_url, demo_url, github_url, features, is_active !== false, id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/products/delete', adminAuth, async (req, res) => {
  await db.query('UPDATE products SET is_active=FALSE WHERE id=$1', [req.body.id]);
  res.json({ ok: true });
});

// Serve frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 4000;
initDB().then(() => app.listen(PORT, () => console.log(`HSSIQ License Server running on port ${PORT}`)));
