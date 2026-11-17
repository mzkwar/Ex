const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'war_ftth_super_secret_key_2026';
const FTTH_BASE_URL = 'https://admin.ftth.iq/api';

// إعدادات Express
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. قاعدة البيانات المحلية SQLite3
// ==========================================
const dbPath = path.join(__dirname, 'war_center.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
  else console.log('✅ تم الاتصال بقاعدة بيانات SQLite بنجاح.');
});

db.serialize(() => {
  // جدول الوكلاء الثانويين
  db.run(`
    CREATE TABLE IF NOT EXISTS sub_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول ربط المشتركين بالوكلاء الثانويين
  db.run(`
    CREATE TABLE IF NOT EXISTS assigned_subscribers (
      subscription_id TEXT PRIMARY KEY,
      sub_agent_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sub_agent_id) REFERENCES sub_agents(id) ON DELETE CASCADE
    )
  `);
});

// دوال مساعدة للتعامل مع SQLite بـ Promises
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

// ==========================================
// 2. مسار Keep-Alive لمنع سبات Render
// ==========================================
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'alive', service: 'War Internet Center', timestamp: new Date().toISOString() });
});

// مؤقت داخلي كل 10 دقائق
setInterval(() => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) {
    const client = externalUrl.startsWith('https') ? https : http;
    client.get(`${externalUrl}/ping`, (res) => {
      console.log(`[Keep-Alive] Ping sent to ${externalUrl}/ping - Status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[Keep-Alive] Ping failed:', err.message);
    });
  }
}, 10 * 60 * 1000);

// ==========================================
// 3. مسارات المصادقة (رئيسي FTTH + وكيل فرعي)
// ==========================================

// تسجيل دخول الوكيل الرئيسي عبر منظومة FTTH
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('client_id', 'earthlink-portals');
    params.append('username', username);
    params.append('password', password);

    const response = await axios.post(`${FTTH_BASE_URL}/auth/Contractor/token`, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const data = response.data;
    const token = data.access_token || data.token || (data.data && data.data.access_token);

    if (!token) {
      return res.status(401).json({ message: 'لم يتم العثور على رمز الدخول في استجابة المنظومة.' });
    }

    res.json({
      role: 'admin',
      token,
      username,
      expires_in: data.expires_in || 86400
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const msg = error.response?.data?.error_description || error.response?.data?.message || 'فشل تسجيل الدخول. تأكد من اسم المستخدم وكلمة المرور.';
    res.status(status).json({ message: msg });
  }
});

// تسجيل دخول الوكيل الثانوي المحلي
app.post('/api/auth/sub-login', async (req, res) => {
  const { username, password, masterToken } = req.body;
  try {
    const agent = await dbGet('SELECT * FROM sub_agents WHERE username = ?', [username]);
    if (!agent) {
      return res.status(401).json({ message: 'اسم مستخدم الوكيل الثانوي غير صحيح.' });
    }

    const isMatch = await bcrypt.compare(password, agent.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'كلمة المرور غير صحيحة.' });
    }

    const localToken = jwt.sign(
      { id: agent.id, username: agent.username, name: agent.name, role: 'sub_agent' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      role: 'sub_agent',
      token: localToken,
      agent: { id: agent.id, name: agent.name, username: agent.username }
    });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في الخادم أثناء تسجيل دخول الوكيل الفرعي.' });
  }
});

// ==========================================
// 4. مسارات إدارة الوكلاء الثانويين والتوزيع
// ==========================================

// جلب قائمة الوكلاء الثانويين مع إحصاء المشتركين
app.get('/api/admin/sub-agents', async (req, res) => {
  try {
    const agents = await dbAll(`
      SELECT 
        sa.id, sa.name, sa.username, sa.phone, sa.created_at,
        COUNT(asub.subscription_id) AS subscriber_count
      FROM sub_agents sa
      LEFT JOIN assigned_subscribers asub ON sa.id = asub.sub_agent_id
      GROUP BY sa.id
      ORDER BY sa.created_at DESC
    `);
    res.json(agents);
  } catch (err) {
    res.status(500).json({ message: 'فشل جلب الوكلاء الثانويين', error: err.message });
  }
});

// إضافة وكيل ثانوي جديد
app.post('/api/admin/sub-agents', async (req, res) => {
  const { name, username, password, phone } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ message: 'الاسم واسم المستخدم وكلمة المرور حقول مطلوبة.' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO sub_agents (name, username, password, phone) VALUES (?, ?, ?, ?)',
      [name, username, hashedPassword, phone || '']
    );
    res.status(201).json({ id: result.lastID, name, username, phone, message: 'تمت إضافة الوكيل بنجاح' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ message: 'اسم المستخدم مستخدم مسبقاً.' });
    }
    res.status(500).json({ message: 'خطأ أثناء إضافة الوكيل', error: err.message });
  }
});

// حذف وكيل ثانوي
app.delete('/api/admin/sub-agents/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM assigned_subscribers WHERE sub_agent_id = ?', [req.params.id]);
    await dbRun('DELETE FROM sub_agents WHERE id = ?', [req.params.id]);
    res.json({ message: 'تم حذف الوكيل وإلغاء ربط مشتركيه.' });
  } catch (err) {
    res.status(500).json({ message: 'فشل حذف الوكيل' });
  }
});

// تحويل وتوزيع المشتركين المحددين إلى وكيل ثانوي
app.post('/api/admin/assign', async (req, res) => {
  const { sub_agent_id, subscription_ids } = req.body;
  if (!Array.isArray(subscription_ids) || subscription_ids.length === 0) {
    return res.status(400).json({ message: 'يرجى تحديد مشترك واحد على الأقل.' });
  }

  try {
    if (sub_agent_id === 'unassign' || !sub_agent_id) {
      const placeholders = subscription_ids.map(() => '?').join(',');
      await dbRun(`DELETE FROM assigned_subscribers WHERE subscription_id IN (${placeholders})`, subscription_ids);
      return res.json({ message: `تم إلغاء تعيين ${subscription_ids.length} مشترك.` });
    }

    for (const subId of subscription_ids) {
      await dbRun(
        `INSERT INTO assigned_subscribers (subscription_id, sub_agent_id) 
         VALUES (?, ?) 
         ON CONFLICT(subscription_id) DO UPDATE SET sub_agent_id = excluded.sub_agent_id, assigned_at = CURRENT_TIMESTAMP`,
        [String(subId), sub_agent_id]
      );
    }
    res.json({ message: `تم تحويل ${subscription_ids.length} مشترك بنجاح.` });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ أثناء تحويل المشتركين', error: err.message });
  }
});

// ==========================================
// 5. تكامل APIs منظومة FTTH ودمج البيانات
// ==========================================

// دالة مساعدة لتمرير الطلبات إلى admin.ftth.iq
async function ftthRequest(endpoint, token, params = {}) {
  const cleanToken = token.replace(/^Bearer\s+/i, '');
  const response = await axios.get(`${FTTH_BASE_URL}${endpoint}`, {
    params,
    headers: {
      'Authorization': `Bearer ${cleanToken}`,
      'Accept': 'application/json'
    },
    timeout: 25000
  });
  return response.data;
}

// جلب ودمج الاشتراكات + العملاء + ربط الوكلاء المحليين
app.get('/api/ftth/merged-subscribers', async (req, res) => {
  const ftthToken = req.headers['x-ftth-token'];
  const subAgentId = req.headers['x-sub-agent-id']; // في حال دخول وكيل ثانوي

  if (!ftthToken) {
    return res.status(401).json({ message: 'رمز مصادقة FTTH مفقود.' });
  }

  try {
    // سحب الاشتراكات والعملاء بالتوازي
    const [subsRes, custRes] = await Promise.all([
      ftthRequest('/subscriptions', ftthToken, { hierarchyLevel: 0, pageSize: 2000, pageNumber: 1 }),
      ftthRequest('/customers', ftthToken, { hierarchyLevel: 1, pageSize: 2000, pageNumber: 1 })
    ]);

    const subscriptions = Array.isArray(subsRes) ? subsRes : (subsRes.items || subsRes.data || []);
    const customers = Array.isArray(custRes) ? custRes : (custRes.items || custRes.data || []);

    // بناء خريطة سريعة للعملاء للدمج الفوري O(1)
    const customerMap = new Map();
    customers.forEach(c => {
      const id = String(c.id || c.customerId || '');
      if (id) customerMap.set(id, c);
    });

    // جلب التعيينات من SQLite
    const assignments = await dbAll(`
      SELECT asub.subscription_id, asub.sub_agent_id, sa.name AS agent_name 
      FROM assigned_subscribers asub
      JOIN sub_agents sa ON asub.sub_agent_id = sa.id
    `);
    const assignMap = new Map();
    assignments.forEach(a => assignMap.set(String(a.subscription_id), a));

    // دمج وتوحيد الحقول بمرونة عالية
    let merged = subscriptions.map(sub => {
      const subId = String(sub.id || sub.subscriptionId || '');
      const custId = String(sub.customerId || sub.customer?.id || '');
      const cust = customerMap.get(custId) || sub.customer || {};
      const assigned = assignMap.get(subId);

      // استخراج البيانات المرنة
      const fullName = cust.fullName || cust.name || sub.customerName || `${cust.firstName || ''} ${cust.lastName || ''}`.trim() || 'بدون اسم';
      const phone = cust.phoneNumber || cust.mobile || cust.phone || sub.phoneNumber || 'غير متوفر';
      const zone = sub.zoneName || sub.zone?.name || cust.zoneName || cust.zone || 'غير محدد';
      const fat = sub.fatName || sub.fat?.name || sub.splitter || cust.fatName || 'غير محدد';
      const bundle = sub.bundleName || sub.bundle?.name || sub.planName || sub.profile || 'غير محدد';
      const status = (sub.status || sub.subscriptionStatus || 'Active').toString();
      const isOnline = Boolean(sub.isOnline || sub.online || sub.hasActiveSession || sub.sessionStatus === 'Online');
      const activationDate = sub.activationDate || sub.startDate || sub.createdAt || null;
      const expirationDate = sub.expirationDate || sub.endDate || sub.expiryDate || null;

      return {
        id: subId,
        customerId: custId,
        username: sub.username || sub.pppoeUsername || subId,
        fullName,
        phone,
        zone,
        fat,
        bundle,
        status,
        isOnline,
        activationDate,
        expirationDate,
        subAgentId: assigned ? assigned.sub_agent_id : null,
        subAgentName: assigned ? assigned.agent_name : null,
        rawCustomer: cust,
        rawSubscription: sub
      };
    });

    // تصفية البيانات إذا كان المستخدم وكيل ثانوي
    if (subAgentId) {
      merged = merged.filter(item => String(item.subAgentId) === String(subAgentId));
    }

    res.json({ total: merged.length, subscribers: merged });
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({
      message: status === 401 ? 'انتهت صلاحية جلسة FTTH، يرجى إعادة تسجيل الدخول.' : 'فشل جلب ودمج بيانات المشتركين من المنظومة.',
      details: error.message
    });
  }
});

// فحص جهاز ONT وقراءة الإشارة
app.get('/api/ftth/ont', async (req, res) => {
  const ftthToken = req.headers['x-ftth-token'];
  const { subscriptionId } = req.query;
  try {
    const data = await ftthRequest('/subscriptions/device/ont', ftthToken, { subscriptionId });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'تعذر قراءة بيانات جهاز ONT', details: error.message });
  }
});

// تفاصيل الجلسة النشطة (IP, MAC, Uptime)
app.get('/api/ftth/sessions', async (req, res) => {
  const ftthToken = req.headers['x-ftth-token'];
  const { subscriptionId } = req.query;
  try {
    const data = await ftthRequest('/sessions', ftthToken, { subscriptionId });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'تعذر جلب الجلسة النشطة', details: error.message });
  }
});

// المحفظة والحركات المالية
app.get('/api/ftth/finance', async (req, res) => {
  const ftthToken = req.headers['x-ftth-token'];
  try {
    const [wallet, transactionsRes] = await Promise.all([
      ftthRequest('/wallet', ftthToken).catch(() => ({ balance: 0 })),
      ftthRequest('/transactions', ftthToken, { pageSize: 200, pageNumber: 1 }).catch(() => [])
    ]);

    const rawTx = Array.isArray(transactionsRes) ? transactionsRes : (transactionsRes.items || transactionsRes.data || []);
    // استبعاد العمليات الصفرية
    const filteredTx = rawTx.filter(tx => {
      const amount = parseFloat(tx.amount ?? tx.value ?? 0);
      return amount !== 0;
    });

    res.json({ wallet, transactions: filteredTx });
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'فشل جلب البيانات المالية', details: error.message });
  }
});

// تذاكر الدعم الفني ومهام التنصيب
app.get('/api/ftth/operations', async (req, res) => {
  const ftthToken = req.headers['x-ftth-token'];
  try {
    const [ticketsRes, requestsRes] = await Promise.all([
      ftthRequest('/support/tickets', ftthToken, { pageSize: 100 }).catch(() => []),
      ftthRequest('/requests', ftthToken, { pageSize: 100 }).catch(() => [])
    ]);

    const tickets = Array.isArray(ticketsRes) ? ticketsRes : (ticketsRes.items || ticketsRes.data || []);
    const requests = Array.isArray(requestsRes) ? requestsRes : (requestsRes.items || requestsRes.data || []);

    res.json({ tickets, requests });
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'فشل جلب التذاكر والمهام', details: error.message });
  }
});

// ==========================================
// 6. الواجهة الأمامية المتكاملة (HTML5 + Tailwind + Vanilla JS)
// ==========================================
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ar" dir="rtl" class="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>مركز وار لخدمات الإنترنت | نظام إدارة المشتركين</title>
  
  <!-- خط Tajawal العربي -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
  
  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: { sans: ['Tajawal', 'sans-serif'] },
          colors: {
            brand: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 900: '#1e3a8a' }
          }
        }
      }
    }
  </script>

  <!-- مكتبة SheetJS لتصدير Excel -->
  <script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>
  <!-- أيقونات Lucide -->
  <script src="https://unpkg.com/lucide@latest"></script>

  <style>
    body { font-family: 'Tajawal', sans-serif; }
    .circular-stat { transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
    .circular-stat:hover { transform: translateY(-4px); }
    .circular-stat.active-filter { ring-width: 4px; transform: scale(1.04); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 4px; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100 transition-colors duration-200 min-h-screen">

  <!-- إشعارات Toast -->
  <div id="toast-container" class="fixed bottom-5 left-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"></div>

  <!-- شريط التحميل المستمر النابض (Persistent Loading State) -->
  <div id="persistent-loader" class="hidden fixed top-0 inset-x-0 z-50 bg-brand-600/95 text-white px-4 py-2.5 shadow-lg backdrop-blur-sm animate-pulse">
    <div class="max-w-7xl mx-auto flex items-center justify-center gap-3 text-sm font-bold">
      <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span id="loader-text">جاري سحب ودمج البيانات من منظومة FTTH الأساسية... يرجى الانتظار</span>
    </div>
  </div>

  <!-- ==========================================
       شاشة تسجيل الدخول (Login View)
       ========================================== -->
  <div id="login-view" class="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-slate-100 via-blue-50 to-slate-200 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
    <div class="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-8">
      <div class="text-center mb-8">
        <div class="w-16 h-16 bg-brand-600 text-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-brand-500/30">
          <i data-lucide="wifi" class="w-9 h-9"></i>
        </div>
        <h1 class="text-2xl font-extrabold text-slate-900 dark:text-white">مركز وار لخدمات الإنترنت</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">بوابة إدارة المشتركين والوكلاء المتكاملة (FTTH)</p>
      </div>

      <!-- تبويب نوع الدخول -->
      <div class="grid grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-6">
        <button type="button" onclick="switchLoginRole('admin')" id="tab-role-admin" class="py-2 text-sm font-bold rounded-lg bg-white dark:bg-slate-700 text-brand-600 dark:text-white shadow-sm transition">
          الوكيل الرئيسي (FTTH)
        </button>
        <button type="button" onclick="switchLoginRole('sub')" id="tab-role-sub" class="py-2 text-sm font-bold rounded-lg text-slate-500 dark:text-slate-400 transition">
          وكيل ثانوي
        </button>
      </div>

      <form id="login-form" class="space-y-4">
        <div>
          <label class="block text-sm font-bold mb-1.5">اسم المستخدم</label>
          <input type="text" id="login-username" required placeholder="أدخل اسم المستخدم" class="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-brand-500 outline-none" />
        </div>
        <div>
          <label class="block text-sm font-bold mb-1.5">كلمة المرور</label>
          <input type="password" id="login-password" required placeholder="••••••••" class="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-brand-500 outline-none" />
        </div>
        <div id="sub-master-token-box" class="hidden">
          <label class="block text-xs font-bold text-amber-600 dark:text-amber-400 mb-1">ملاحظة للوكيل الثانوي:</label>
          <p class="text-xs text-slate-500 dark:text-slate-400">يتم جلب بيانات مشتركيك المحددين تلقائياً عبر ربط المنظومة.</p>
        </div>
        <button type="submit" id="login-btn" class="w-full py-3 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl shadow-lg shadow-brand-500/30 transition flex items-center justify-center gap-2">
          <span>تسجيل الدخول</span>
          <i data-lucide="log-in" class="w-4 h-4"></i>
        </button>
      </form>
    </div>
  </div>

  <!-- ==========================================
       لوحة التحكم الرئيسية (Dashboard View)
       ========================================== -->
  <div id="app-view" class="hidden min-h-screen flex flex-col">
    <!-- الشريط العلوي Navbar -->
    <header class="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-brand-600 text-white rounded-xl flex items-center justify-center font-bold shadow">
            <i data-lucide="router" class="w-5 h-5"></i>
          </div>
          <div>
            <h1 class="font-extrabold text-base sm:text-lg leading-tight">مركز وار لخدمات الإنترنت</h1>
            <span id="user-badge" class="text-xs text-brand-600 dark:text-brand-400 font-bold">وكيل رئيسي</span>
          </div>
        </div>

        <!-- قائمة التنقل -->
        <nav class="hidden md:flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
          <button onclick="switchTab('subscribers')" data-tab="subscribers" class="nav-btn px-4 py-1.5 rounded-lg text-sm font-bold bg-white dark:bg-slate-700 text-brand-600 dark:text-white shadow-sm">المشتركين</button>
          <button onclick="switchTab('agents')" data-tab="agents" id="nav-agents-btn" class="nav-btn px-4 py-1.5 rounded-lg text-sm font-bold text-slate-600 dark:text-slate-300">الوكلاء الثانويين</button>
          <button onclick="switchTab('finance')" data-tab="finance" id="nav-finance-btn" class="nav-btn px-4 py-1.5 rounded-lg text-sm font-bold text-slate-600 dark:text-slate-300">المحفظة والمالية</button>
          <button onclick="switchTab('operations')" data-tab="operations" id="nav-ops-btn" class="nav-btn px-4 py-1.5 rounded-lg text-sm font-bold text-slate-600 dark:text-slate-300">الدعم والمهام</button>
        </nav>

        <div class="flex items-center gap-2">
          <button onclick="fetchAllData(true)" title="تحديث البيانات" class="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
          <button onclick="toggleTheme()" title="الوضع الليلي/النهاري" class="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition">
            <i data-lucide="moon" id="theme-icon" class="w-4 h-4"></i>
          </button>
          <button onclick="logout()" title="تسجيل الخروج" class="p-2 rounded-xl bg-red-50 dark:bg-red-950/50 text-red-600 hover:bg-red-100 transition">
            <i data-lucide="log-out" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <!-- قائمة الهاتف المحمول -->
      <div class="flex md:hidden overflow-x-auto gap-1 px-4 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <button onclick="switchTab('subscribers')" data-tab="subscribers" class="nav-btn px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap bg-brand-600 text-white">المشتركين</button>
        <button onclick="switchTab('agents')" data-tab="agents" id="mob-agents-btn" class="nav-btn px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap text-slate-600 dark:text-slate-300">الوكلاء الثانويين</button>
        <button onclick="switchTab('finance')" data-tab="finance" id="mob-finance-btn" class="nav-btn px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap text-slate-600 dark:text-slate-300">المحفظة والمالية</button>
        <button onclick="switchTab('operations')" data-tab="operations" id="mob-ops-btn" class="nav-btn px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap text-slate-600 dark:text-slate-300">الدعم والمهام</button>
      </div>
    </header>

    <!-- المحتوى الرئيسي -->
    <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">

      <!-- ==========================================
           القسم 1: المشتركين والإحصائيات الدائرية
           ========================================== -->
      <section id="tab-subscribers" class="space-y-6">
        <!-- الإحصائيات الدائرية التفاعلية -->
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <!-- إجمالي المشتركين -->
          <div onclick="setQuickFilter('all')" id="stat-all" class="circular-stat active-filter cursor-pointer bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col items-center text-center ring-brand-500">
            <div class="w-16 h-16 rounded-full border-4 border-brand-500 flex items-center justify-center mb-2 bg-brand-50 dark:bg-brand-950/40">
              <span id="count-all" class="text-lg font-extrabold text-brand-600 dark:text-brand-400">0</span>
            </div>
            <span class="text-sm font-bold">إجمالي المشتركين</span>
          </div>

          <!-- الفعالين -->
          <div onclick="setQuickFilter('active')" id="stat-active" class="circular-stat cursor-pointer bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col items-center text-center ring-emerald-500">
            <div class="w-16 h-16 rounded-full border-4 border-emerald-500 flex items-center justify-center mb-2 bg-emerald-50 dark:bg-emerald-950/40">
              <span id="count-active" class="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">0</span>
            </div>
            <span class="text-sm font-bold">الفعالين</span>
          </div>

          <!-- المتصلين الآن -->
          <div onclick="setQuickFilter('online')" id="stat-online" class="circular-stat cursor-pointer bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col items-center text-center ring-cyan-500">
            <div class="w-16 h-16 rounded-full border-4 border-cyan-500 flex items-center justify-center mb-2 bg-cyan-50 dark:bg-cyan-950/40">
              <span id="count-online" class="text-lg font-extrabold text-cyan-600 dark:text-cyan-400">0</span>
            </div>
            <span class="text-sm font-bold">المتصلين الآن</span>
          </div>

          <!-- غير المتصلين -->
          <div onclick="setQuickFilter('offline')" id="stat-offline" class="circular-stat cursor-pointer bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col items-center text-center ring-slate-400">
            <div class="w-16 h-16 rounded-full border-4 border-slate-400 flex items-center justify-center mb-2 bg-slate-100 dark:bg-slate-800">
              <span id="count-offline" class="text-lg font-extrabold text-slate-600 dark:text-slate-300">0</span>
            </div>
            <span class="text-sm font-bold">غير المتصلين</span>
          </div>

          <!-- المنتهية خلال 7 أيام -->
          <div onclick="setQuickFilter('expiring7')" id="stat-expiring7" class="circular-stat cursor-pointer bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col items-center text-center ring-amber-500 col-span-2 sm:col-span-1">
            <div class="w-16 h-16 rounded-full border-4 border-amber-500 flex items-center justify-center mb-2 bg-amber-50 dark:bg-amber-950/40">
              <span id="count-expiring7" class="text-lg font-extrabold text-amber-600 dark:text-amber-400">0</span>
            </div>
            <span class="text-sm font-bold">تنتهي خلال 7 أيام</span>
          </div>
        </div>

        <!-- شريط البحث والفرز والتصدير والتحويل -->
        <div class="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div class="flex flex-col lg:flex-row gap-3 justify-between">
            <!-- البحث الفوري -->
            <div class="relative flex-1">
              <i data-lucide="search" class="w-4 h-4 absolute right-3.5 top-3 text-slate-400"></i>
              <input type="text" id="search-input" oninput="applyFilters()" placeholder="بحث فوري بالاسم، رقم الهاتف، الزون (Zone)، أو الفات (FAT)..." class="w-full pr-10 pl-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:ring-2 focus:ring-brand-500 outline-none" />
            </div>

            <!-- الفرز -->
            <div class="flex flex-wrap items-center gap-2">
              <select id="sort-select" onchange="applyFilters()" class="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-medium outline-none">
                <option value="name_asc">الفرز: الاسم (أ - ي)</option>
                <option value="online_first">الفرز: المتصلين أولاً</option>
                <option value="bundle_asc">الفرز: نوع الباقة</option>
                <option value="activation_desc">الفرز: تاريخ التفعيل (الأحدث)</option>
              </select>

              <!-- تصدير Excel -->
              <button onclick="exportToExcel('filtered')" class="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-bold flex items-center gap-1.5 transition shadow-sm">
                <i data-lucide="file-spreadsheet" class="w-4 h-4"></i>
                <span>تصدير المعروض</span>
              </button>
              <button onclick="exportToExcel('all')" class="px-3.5 py-2 bg-slate-800 dark:bg-slate-700 hover:bg-slate-700 text-white rounded-xl text-sm font-bold flex items-center gap-1.5 transition shadow-sm">
                <i data-lucide="download" class="w-4 h-4"></i>
                <span>تصدير الكل</span>
              </button>
            </div>
          </div>

          <!-- شريط تحويل المشتركين للوكيل الثانوي (يظهر للوكيل الرئيسي عند التحديد) -->
          <div id="assign-bar" class="hidden pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-brand-50/60 dark:bg-brand-950/30 p-3 rounded-xl">
            <div class="text-sm font-bold text-brand-700 dark:text-brand-300">
              تم تحديد <span id="selected-count" class="underline">0</span> مشترك
            </div>
            <div class="flex items-center gap-2">
              <select id="assign-agent-select" class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm outline-none">
                <option value="">-- اختر الوكيل الثانوي --</option>
              </select>
              <button onclick="assignSelectedSubscribers()" class="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-bold transition">
                تحويل المشتركين
              </button>
            </div>
          </div>
        </div>

        <!-- جدول المشتركين -->
        <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-right border-collapse">
              <thead>
                <tr class="bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 text-xs uppercase border-b border-slate-200 dark:border-slate-700">
                  <th class="p-3.5 w-10 text-center admin-only-col">
                    <input type="checkbox" id="select-all-checkbox" onchange="toggleSelectAll(this)" class="rounded border-slate-300" />
                  </th>
                  <th class="p-3.5">#</th>
                  <th class="p-3.5">اسم المشترك</th>
                  <th class="p-3.5">رقم الهاتف</th>
                  <th class="p-3.5">الزون (Zone)</th>
                  <th class="p-3.5">الفات (FAT)</th>
                  <th class="p-3.5">الباقة</th>
                  <th class="p-3.5">الحالة والاتصال</th>
                  <th class="p-3.5 admin-only-col">الوكيل الثانوي</th>
                  <th class="p-3.5 text-center">التفاصيل</th>
                </tr>
              </thead>
              <tbody id="subscribers-tbody" class="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                <tr>
                  <td colspan="10" class="p-8 text-center text-slate-400">جاري تحميل قائمة المشتركين...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ==========================================
           القسم 2: صفحة تفاصيل المشترك المستقلة (Modal / View)
           ========================================== -->
      <section id="tab-subscriber-detail" class="hidden space-y-6">
        <div class="flex items-center justify-between">
          <button onclick="switchTab('subscribers')" class="px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 rounded-xl text-sm font-bold flex items-center gap-2 transition">
            <i data-lucide="arrow-right" class="w-4 h-4"></i>
            <span>العودة إلى قائمة المشتركين</span>
          </button>
          <span id="detail-sub-id" class="text-xs font-mono bg-slate-200 dark:bg-slate-800 px-3 py-1 rounded-lg"></span>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- البطاقة الشخصية والموقع الجغرافي -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div class="flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div class="w-12 h-12 rounded-2xl bg-brand-100 dark:bg-brand-900/40 text-brand-600 flex items-center justify-center font-extrabold text-xl">
                <i data-lucide="user" class="w-6 h-6"></i>
              </div>
              <div>
                <h2 id="detail-name" class="text-lg font-extrabold">-</h2>
                <p id="detail-username" class="text-xs text-slate-500 font-mono">-</p>
              </div>
            </div>

            <div class="space-y-2.5 text-sm">
              <div class="flex justify-between"><span class="text-slate-500">رقم الهاتف:</span><span id="detail-phone" class="font-bold">-</span></div>
              <div class="flex justify-between"><span class="text-slate-500">المنطقة (Zone):</span><span id="detail-zone" class="font-bold">-</span></div>
              <div class="flex justify-between"><span class="text-slate-500">نقطة التوزيع (FAT):</span><span id="detail-fat" class="font-bold">-</span></div>
              <div class="flex justify-between"><span class="text-slate-500">الباقة الحالية:</span><span id="detail-bundle" class="font-bold text-brand-600">-</span></div>
              <div class="flex justify-between"><span class="text-slate-500">تاريخ التفعيل:</span><span id="detail-activation" class="font-bold">-</span></div>
              <div class="flex justify-between"><span class="text-slate-500">تاريخ الانتهاء:</span><span id="detail-expiration" class="font-bold">-</span></div>
            </div>

            <div id="detail-map-box" class="pt-3 border-t border-slate-100 dark:border-slate-800">
              <a id="detail-maps-link" href="#" target="_blank" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition">
                <i data-lucide="map-pin" class="w-4 h-4"></i>
                <span>فتح الموقع على خرائط جوجل</span>
              </a>
            </div>
          </div>

          <!-- فحص جهاز ONT وقراءة الإشارة -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
              <h3 class="font-extrabold text-base flex items-center gap-2">
                <i data-lucide="activity" class="w-5 h-5 text-cyan-500"></i>
                <span>فحص جهاز ONT والإشارة</span>
              </h3>
              <button onclick="reloadOntAndSession()" class="text-xs text-brand-600 font-bold hover:underline">تحديث الفحص</button>
            </div>

            <div id="ont-data-container" class="space-y-3 text-sm">
              <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-center text-slate-400 animate-pulse">
                جاري فحص الجهاز وقراءة Rx Power...
              </div>
            </div>
          </div>

          <!-- تفاصيل الجلسة النشطة (IP, MAC, Uptime) -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
              <h3 class="font-extrabold text-base flex items-center gap-2">
                <i data-lucide="globe" class="w-5 h-5 text-emerald-500"></i>
                <span>تفاصيل الجلسة النشطة</span>
              </h3>
            </div>

            <div id="session-data-container" class="space-y-3 text-sm">
              <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-center text-slate-400 animate-pulse">
                جاري جلب بيانات الجلسة (IP / MAC)...
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ==========================================
           القسم 3: إدارة الوكلاء الثانويين (Sub-Agents)
           ========================================== -->
      <section id="tab-agents" class="hidden space-y-6">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- نموذج إضافة وكيل ثانوي -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm h-fit">
            <h2 class="text-lg font-extrabold mb-4 flex items-center gap-2">
              <i data-lucide="user-plus" class="w-5 h-5 text-brand-600"></i>
              <span>إضافة وكيل ثانوي جديد</span>
            </h2>
            <form id="add-agent-form" class="space-y-3.5">
              <div>
                <label class="block text-xs font-bold mb-1">اسم الوكيل / النقطة</label>
                <input type="text" id="agent-name" required placeholder="مثال: مكتب النور للإنترنت" class="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm outline-none" />
              </div>
              <div>
                <label class="block text-xs font-bold mb-1">اسم المستخدم للدخول</label>
                <input type="text" id="agent-username" required placeholder="noor_agent" class="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm outline-none" />
              </div>
              <div>
                <label class="block text-xs font-bold mb-1">كلمة المرور</label>
                <input type="password" id="agent-password" required placeholder="••••••••" class="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm outline-none" />
              </div>
              <div>
                <label class="block text-xs font-bold mb-1">رقم الهاتف</label>
                <input type="text" id="agent-phone" placeholder="07800000000" class="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm outline-none" />
              </div>
              <button type="submit" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-sm transition">
                إنشاء حساب الوكيل
              </button>
            </form>
          </div>

          <!-- قائمة الوكلاء الثانويين -->
          <div class="lg:col-span-2 bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <h2 class="text-lg font-extrabold mb-4">الوكلاء الثانويين المعتمدين</h2>
            <div class="overflow-x-auto">
              <table class="w-full text-right text-sm">
                <thead>
                  <tr class="bg-slate-100 dark:bg-slate-800 text-xs border-b border-slate-200 dark:border-slate-700">
                    <th class="p-3">اسم الوكيل</th>
                    <th class="p-3">اسم المستخدم</th>
                    <th class="p-3">الهاتف</th>
                    <th class="p-3 text-center">عدد المشتركين</th>
                    <th class="p-3 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody id="agents-tbody" class="divide-y divide-slate-100 dark:divide-slate-800"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <!-- ==========================================
           القسم 4: المحفظة والحركات المالية
           ========================================== -->
      <section id="tab-finance" class="hidden space-y-6">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-gradient-to-l from-brand-600 to-brand-800 text-white p-6 rounded-2xl shadow-lg">
            <span class="text-xs opacity-80 font-bold">رصيد المحفظة الحالي</span>
            <div id="wallet-balance" class="text-3xl font-extrabold mt-2">0 IQD</div>
          </div>
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <span class="text-xs text-slate-500 font-bold">دفعات المشتركين (Card)</span>
            <div id="card-payments-count" class="text-2xl font-extrabold text-emerald-600 mt-2">0 عملية</div>
          </div>
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <span class="text-xs text-slate-500 font-bold">دفعات الوكيل (Wallet)</span>
            <div id="wallet-payments-count" class="text-2xl font-extrabold text-amber-600 mt-2">0 عملية</div>
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 class="font-extrabold text-lg">سجل الحركات المالية (مستبعدة العمليات الصفرية)</h3>
            <select id="payment-mode-filter" onchange="renderTransactions()" class="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm">
              <option value="all">جميع طرق الدفع</option>
              <option value="Card">دفع المشترك (Card)</option>
              <option value="Wallet">دفع الوكيل (Wallet)</option>
            </select>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-right text-sm">
              <thead>
                <tr class="bg-slate-100 dark:bg-slate-800 text-xs">
                  <th class="p-3">التاريخ</th>
                  <th class="p-3">التفاصيل / المشترك</th>
                  <th class="p-3">طريقة الدفع (paymentMode)</th>
                  <th class="p-3">المبلغ</th>
                </tr>
              </thead>
              <tbody id="transactions-tbody" class="divide-y divide-slate-100 dark:divide-slate-800"></tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ==========================================
           القسم 5: الدعم الفني ومهام التنصيب
           ========================================== -->
      <section id="tab-operations" class="hidden space-y-6">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- تذاكر الدعم الفني -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <h3 class="font-extrabold text-lg mb-4 flex items-center gap-2">
              <i data-lucide="life-buoy" class="w-5 h-5 text-red-500"></i>
              <span>تذاكر الدعم الفني</span>
            </h3>
            <div id="tickets-list" class="space-y-3"></div>
          </div>

          <!-- مهام التنصيب -->
          <div class="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <h3 class="font-extrabold text-lg mb-4 flex items-center gap-2">
              <i data-lucide="wrench" class="w-5 h-5 text-brand-600"></i>
              <span>مهام التنصيب والطلبات</span>
            </h3>
            <div id="requests-list" class="space-y-3"></div>
          </div>
        </div>
      </section>

    </main>
  </div>

  <!-- ==========================================
       منطق الواجهة الأمامية (Vanilla JS)
       ========================================== -->
  <script>
    // حالة التطبيق العامة
    const state = {
      token: localStorage.getItem('war_ftth_token') || '',
      role: localStorage.getItem('war_user_role') || 'admin',
      subAgentId: localStorage.getItem('war_sub_agent_id') || '',
      username: localStorage.getItem('war_username') || '',
      loginRoleMode: 'admin',
      allSubscribers: [],
      filteredSubscribers: [],
      selectedIds: new Set(),
      quickFilter: 'all',
      subAgents: [],
      transactions: [],
      currentDetailSub: null
    };

    // تهيئة الأيقونات والثيم عند التحميل
    document.addEventListener('DOMContentLoaded', () => {
      lucide.createIcons();
      initTheme();
      if (state.token) {
        showDashboard();
      } else {
        showLogin();
      }
    });

    // إدارة الوضع الليلي والنهاري
    function initTheme() {
      const savedTheme = localStorage.getItem('war_theme') || 'light';
      document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    }

    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('war_theme', isDark ? 'dark' : 'light');
      showToast(isDark ? 'تم تفعيل الوضع الليلي' : 'تم تفعيل الوضع النهاري', 'info');
    }

    // إشعارات Toast احترافية
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const colors = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-red-600 text-white',
        info: 'bg-slate-800 text-white dark:bg-brand-600'
      };
      const toast = document.createElement('div');
      toast.className = \`\${colors[type] || colors.info} px-4 py-3 rounded-xl shadow-xl text-sm font-bold flex items-center justify-between gap-3 pointer-events-auto transform transition-all duration-300\`;
      toast.innerHTML = \`<span>\${message}</span>\`;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    }

    // التحكم بمؤشر التحميل المستمر النابض
    function setLoading(isLoading, text = 'جاري سحب ودمج البيانات من منظومة FTTH الأساسية...') {
      const loader = document.getElementById('persistent-loader');
      document.getElementById('loader-text').textContent = text;
      loader.classList.toggle('hidden', !isLoading);
    }

    // تبديل نوع الدخول (رئيسي / ثانوي)
    function switchLoginRole(mode) {
      state.loginRoleMode = mode;
      const adminTab = document.getElementById('tab-role-admin');
      const subTab = document.getElementById('tab-role-sub');
      const subNote = document.getElementById('sub-master-token-box');

      if (mode === 'admin') {
        adminTab.className = 'py-2 text-sm font-bold rounded-lg bg-white dark:bg-slate-700 text-brand-600 dark:text-white shadow-sm transition';
        subTab.className = 'py-2 text-sm font-bold rounded-lg text-slate-500 dark:text-slate-400 transition';
        subNote.classList.add('hidden');
      } else {
        subTab.className = 'py-2 text-sm font-bold rounded-lg bg-white dark:bg-slate-700 text-brand-600 dark:text-white shadow-sm transition';
        adminTab.className = 'py-2 text-sm font-bold rounded-lg text-slate-500 dark:text-slate-400 transition';
        subNote.classList.remove('hidden');
      }
    }

    // معالجة تسجيل الدخول
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const btn = document.getElementById('login-btn');
      btn.disabled = true;

      try {
        if (state.loginRoleMode === 'admin') {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'فشل تسجيل الدخول');

          localStorage.setItem('war_ftth_token', data.token);
          localStorage.setItem('war_master_ftth_token', data.token);
          localStorage.setItem('war_user_role', 'admin');
          localStorage.setItem('war_username', username);
          localStorage.removeItem('war_sub_agent_id');

          state.token = data.token;
          state.role = 'admin';
          state.username = username;
          state.subAgentId = '';
        } else {
          // دخول وكيل ثانوي
          const masterToken = localStorage.getItem('war_master_ftth_token');
          if (!masterToken) {
            throw new Error('يجب تسجيل دخول الوكيل الرئيسي مرة واحدة على هذا المتصفح لربط جلسة FTTH.');
          }
          const res = await fetch('/api/auth/sub-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || 'فشل دخول الوكيل الثانوي');

          localStorage.setItem('war_ftth_token', masterToken);
          localStorage.setItem('war_user_role', 'sub_agent');
          localStorage.setItem('war_sub_agent_id', data.agent.id);
          localStorage.setItem('war_username', data.agent.name);

          state.token = masterToken;
          state.role = 'sub_agent';
          state.subAgentId = data.agent.id;
          state.username = data.agent.name;
        }

        showToast('تم تسجيل الدخول بنجاح!', 'success');
        showDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    function logout() {
      localStorage.removeItem('war_ftth_token');
      localStorage.removeItem('war_user_role');
      localStorage.removeItem('war_sub_agent_id');
      state.token = '';
      showLogin();
      showToast('تم تسجيل الخروج', 'info');
    }

    function showLogin() {
      document.getElementById('login-view').classList.remove('hidden');
      document.getElementById('app-view').classList.add('hidden');
    }

    function showDashboard() {
      document.getElementById('login-view').classList.add('hidden');
      document.getElementById('app-view').classList.remove('hidden');

      const badge = document.getElementById('user-badge');
      const isAdmin = state.role === 'admin';
      badge.textContent = isAdmin ? \`وكيل رئيسي (\${state.username})\` : \`وكيل ثانوي: \${state.username}\`;

      // إخفاء تبويبات الإدارة عن الوكيل الثانوي
      ['nav-agents-btn', 'nav-finance-btn', 'nav-ops-btn', 'mob-agents-btn', 'mob-finance-btn', 'mob-ops-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !isAdmin);
      });

      fetchAllData();
    }

    // التنقل بين الأقسام
    function switchTab(tabName) {
      ['subscribers', 'subscriber-detail', 'agents', 'finance', 'operations'].forEach(t => {
        document.getElementById(\`tab-\${t}\`).classList.add('hidden');
      });
      document.getElementById(\`tab-\${tabName}\`).classList.remove('hidden');

      document.querySelectorAll('.nav-btn').forEach(btn => {
        const isMatch = btn.dataset.tab === tabName;
        btn.className = isMatch
          ? 'nav-btn px-4 py-1.5 rounded-lg text-sm font-bold bg-white dark:bg-slate-700 text-brand-600 dark:text-white shadow-sm'
          : 'nav-btn px-4 py-1.5 rounded-lg text-sm font-bold text-slate-600 dark:text-slate-300';
      });
    }

    // جلب كافة البيانات من الخادم
    async function fetchAllData(notify = false) {
      setLoading(true, 'جاري سحب ودمج بيانات المشتركين والوكلاء من منظومة FTTH...');
      try {
        const headers = { 'x-ftth-token': state.token };
        if (state.role === 'sub_agent' && state.subAgentId) {
          headers['x-sub-agent-id'] = state.subAgentId;
        }

        const subRes = await fetch('/api/ftth/merged-subscribers', { headers });
        if (subRes.status === 401) {
          showToast('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً', 'error');
          logout();
          return;
        }
        const subData = await subRes.json();
        if (!subRes.ok) throw new Error(subData.message);

        state.allSubscribers = subData.subscribers || [];
        updateStats();
        applyFilters();

        if (state.role === 'admin') {
          await Promise.all([loadSubAgents(), loadFinance(), loadOperations()]);
        }

        if (notify) showToast('تم تحديث جميع البيانات بنجاح', 'success');
      } catch (err) {
        showToast(err.message || 'حدث خطأ أثناء جلب البيانات', 'error');
      } finally {
        setLoading(false);
      }
    }

    // حساب الإحصائيات الدائرية
    function updateStats() {
      const now = new Date();
      const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      let active = 0, online = 0, offline = 0, expiring7 = 0;

      state.allSubscribers.forEach(s => {
        const isAct = s.status.toLowerCase() === 'active';
        if (isAct) active++;
        if (s.isOnline) online++;
        else offline++;

        if (s.expirationDate) {
          const exp = new Date(s.expirationDate);
          if (exp >= now && exp <= sevenDaysLater) expiring7++;
        }
      });

      document.getElementById('count-all').textContent = state.allSubscribers.length;
      document.getElementById('count-active').textContent = active;
      document.getElementById('count-online').textContent = online;
      document.getElementById('count-offline').textContent = offline;
      document.getElementById('count-expiring7').textContent = expiring7;
    }

    // التصفية السريعة بالنقر على الدوائر
    function setQuickFilter(filterKey) {
      state.quickFilter = filterKey;
      document.querySelectorAll('.circular-stat').forEach(el => el.classList.remove('active-filter'));
      document.getElementById(\`stat-\${filterKey}\`).classList.add('active-filter');
      applyFilters();
    }

    // تطبيق البحث والفلترة والفرز
    function applyFilters() {
      const query = document.getElementById('search-input').value.trim().toLowerCase();
      const sortBy = document.getElementById('sort-select').value;
      const now = new Date();
      const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      let list = state.allSubscribers.filter(s => {
        // فلتر الدوائر
        if (state.quickFilter === 'active' && s.status.toLowerCase() !== 'active') return false;
        if (state.quickFilter === 'online' && !s.isOnline) return false;
        if (state.quickFilter === 'offline' && s.isOnline) return false;
        if (state.quickFilter === 'expiring7') {
          if (!s.expirationDate) return false;
          const exp = new Date(s.expirationDate);
          if (!(exp >= now && exp <= sevenDaysLater)) return false;
        }

        // البحث الفوري
        if (query) {
          const hay = \`\${s.fullName} \${s.phone} \${s.zone} \${s.fat} \${s.username}\`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });

      // الفرز
      list.sort((a, b) => {
        if (sortBy === 'name_asc') return a.fullName.localeCompare(b.fullName, 'ar');
        if (sortBy === 'online_first') return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0);
        if (sortBy === 'bundle_asc') return a.bundle.localeCompare(b.bundle, 'ar');
        if (sortBy === 'activation_desc') return new Date(b.activationDate || 0) - new Date(a.activationDate || 0);
        return 0;
      });

      state.filteredSubscribers = list;
      renderSubscribersTable();
    }

    // رسم جدول المشتركين
    function renderSubscribersTable() {
      const tbody = document.getElementById('subscribers-tbody');
      const isAdmin = state.role === 'admin';

      document.querySelectorAll('.admin-only-col').forEach(el => el.classList.toggle('hidden', !isAdmin));

      if (state.filteredSubscribers.length === 0) {
        tbody.innerHTML = \`<tr><td colspan="10" class="p-8 text-center text-slate-400 font-bold">لا توجد نتائج مطابقة للبحث أو التصفية الحالية.</td></tr>\`;
        return;
      }

      tbody.innerHTML = state.filteredSubscribers.map((s, idx) => {
        const isChecked = state.selectedIds.has(s.id) ? 'checked' : '';
        const onlineBadge = s.isOnline
          ? '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>متصل</span>'
          : '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">غير متصل</span>';

        return \`
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
            \${isAdmin ? \`<td class="p-3.5 text-center"><input type="checkbox" \${isChecked} onchange="toggleRowSelect('\${s.id}')" class="rounded border-slate-300" /></td>\` : ''}
            <td class="p-3.5 font-mono text-xs text-slate-400">\${idx + 1}</td>
            <td class="p-3.5 font-bold text-slate-900 dark:text-white">\${s.fullName}</td>
            <td class="p-3.5 font-mono text-xs" dir="ltr">\${s.phone}</td>
            <td class="p-3.5 text-xs font-medium">\${s.zone}</td>
            <td class="p-3.5 text-xs font-mono">\${s.fat}</td>
            <td class="p-3.5 text-xs font-bold text-brand-600 dark:text-brand-400">\${s.bundle}</td>
            <td class="p-3.5">\${onlineBadge}</td>
            \${isAdmin ? \`<td class="p-3.5 text-xs">\${s.subAgentName ? \`<span class="px-2 py-1 rounded-lg bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 font-bold">\${s.subAgentName}</span>\` : '<span class="text-slate-400">رئيسي</span>'}</td>\` : ''}
            <td class="p-3.5 text-center">
              <button onclick="openSubscriberDetail('\${s.id}')" class="px-3 py-1.5 bg-brand-50 hover:bg-brand-600 text-brand-600 hover:text-white dark:bg-slate-800 dark:text-brand-400 rounded-lg text-xs font-bold transition">
                عرض التفاصيل
              </button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    // تحديد الصفوف للتحويل
    function toggleRowSelect(id) {
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      updateAssignBar();
    }

    function toggleSelectAll(checkbox) {
      if (checkbox.checked) {
        state.filteredSubscribers.forEach(s => state.selectedIds.add(s.id));
      } else {
        state.selectedIds.clear();
      }
      renderSubscribersTable();
      updateAssignBar();
    }

    function updateAssignBar() {
      const bar = document.getElementById('assign-bar');
      const count = state.selectedIds.size;
      document.getElementById('selected-count').textContent = count;
      bar.classList.toggle('hidden', count === 0 || state.role !== 'admin');
    }

    // تصدير Excel باستخدام SheetJS
    function exportToExcel(mode) {
      const source = mode === 'all' ? state.allSubscribers : state.filteredSubscribers;
      if (source.length === 0) {
        showToast('لا توجد بيانات لتصديرها', 'error');
        return;
      }

      const rows = source.map((s, idx) => ({
        'التسلسل': idx + 1,
        'اسم المشترك': s.fullName,
        'رقم الهاتف': s.phone,
        'الزون (Zone)': s.zone,
        'الفات (FAT)': s.fat,
        'الباقة': s.bundle,
        'حالة الاتصال': s.isOnline ? 'متصل' : 'غير متصل'
      }));

      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 15 }, { wch: 20 }, { wch: 14 }];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'مشتركي مركز وار');

      const fileName = \`War_Center_Subscribers_\${new Date().toISOString().slice(0, 10)}.xlsx\`;
      XLSX.writeFile(workbook, fileName);
      showToast(\`تم تصدير \${rows.length} مشترك إلى ملف Excel بنجاح\`, 'success');
    }

    // ==========================================
    // صفحة تفاصيل المشترك المستقلة (ONT + Session + Maps)
    // ==========================================
    async function openSubscriberDetail(subId) {
      const sub = state.allSubscribers.find(s => s.id === subId);
      if (!sub) return;
      state.currentDetailSub = sub;

      switchTab('subscriber-detail');
      document.getElementById('detail-sub-id').textContent = \`ID: \${sub.id}\`;
      document.getElementById('detail-name').textContent = sub.fullName;
      document.getElementById('detail-username').textContent = sub.username;
      document.getElementById('detail-phone').textContent = sub.phone;
      document.getElementById('detail-zone').textContent = sub.zone;
      document.getElementById('detail-fat').textContent = sub.fat;
      document.getElementById('detail-bundle').textContent = sub.bundle;
      document.getElementById('detail-activation').textContent = sub.activationDate ? new Date(sub.activationDate).toLocaleDateString('ar-IQ') : 'غير متوفر';
      document.getElementById('detail-expiration').textContent = sub.expirationDate ? new Date(sub.expirationDate).toLocaleDateString('ar-IQ') : 'غير متوفر';

      // استخراج الإحداثيات الجغرافية
      const lat = sub.rawCustomer?.latitude || sub.rawSubscription?.latitude || sub.rawCustomer?.lat;
      const lng = sub.rawCustomer?.longitude || sub.rawSubscription?.longitude || sub.rawCustomer?.lng;
      const mapBtn = document.getElementById('detail-maps-link');
      if (lat && lng) {
        mapBtn.href = \`https://www.google.com/maps?q=\${lat},\${lng}\`;
        mapBtn.classList.remove('opacity-50', 'pointer-events-none');
      } else {
        mapBtn.href = \`https://www.google.com/maps/search/\${encodeURIComponent(sub.zone + ' ' + sub.fat)}\`;
      }

      await reloadOntAndSession();
    }

    async function reloadOntAndSession() {
      const sub = state.currentDetailSub;
      if (!sub) return;

      const ontBox = document.getElementById('ont-data-container');
      const sesBox = document.getElementById('session-data-container');
      ontBox.innerHTML = '<div class="p-4 text-center text-slate-400 animate-pulse">جاري قراءة إشارة ONT...</div>';
      sesBox.innerHTML = '<div class="p-4 text-center text-slate-400 animate-pulse">جاري فحص الجلسة النشطة...</div>';

      const headers = { 'x-ftth-token': state.token };

      // فحص ONT
      fetch(\`/api/ftth/ont?subscriptionId=\${sub.id}\`, { headers })
        .then(r => r.json())
        .then(data => {
          const rx = data.rxPower ?? data.opticalRxPower ?? data.signal ?? 'غير متاح';
          const tx = data.txPower ?? data.opticalTxPower ?? 'غير متاح';
          const status = data.status || data.operState || 'غير معروف';
          const rxNum = parseFloat(rx);
          const signalColor = !isNaN(rxNum) ? (rxNum >= -25 ? 'text-emerald-600' : rxNum >= -28 ? 'text-amber-500' : 'text-red-600') : 'text-slate-700 dark:text-slate-200';

          ontBox.innerHTML = \`
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">حالة الجهاز:</span><span class="font-bold">\${status}</span></div>
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">قراءة الإشارة (Rx Power):</span><span class="font-extrabold font-mono \${signalColor}" dir="ltr">\${rx} dBm</span></div>
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">إرسال (Tx Power):</span><span class="font-bold font-mono" dir="ltr">\${tx} dBm</span></div>
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">Serial Number:</span><span class="font-mono text-xs">\${data.serialNumber || data.sn || '-'}</span></div>
          \`;
        })
        .catch(() => {
          ontBox.innerHTML = '<div class="p-4 text-center text-red-500 text-xs font-bold">تعذر الوصول إلى جهاز ONT حالياً.</div>';
        });

      // فحص الجلسة النشطة
      fetch(\`/api/ftth/sessions?subscriptionId=\${sub.id}\`, { headers })
        .then(r => r.json())
        .then(data => {
          const session = Array.isArray(data) ? data[0] : (data.items?.[0] || data);
          if (!session || (!session.ipAddress && !session.framedIpAddress && !session.macAddress)) {
            sesBox.innerHTML = '<div class="p-4 text-center text-slate-400 font-bold">لا توجد جلسة اتصال نشطة حالياً.</div>';
            return;
          }
          sesBox.innerHTML = \`
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">عنوان IP:</span><span class="font-mono font-bold text-brand-600" dir="ltr">\${session.ipAddress || session.framedIpAddress || '-'}</span></div>
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">عنوان MAC:</span><span class="font-mono font-bold" dir="ltr">\${session.macAddress || session.callingStationId || '-'}</span></div>
            <div class="flex justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800"><span class="text-slate-500">مدة الاتصال (Uptime):</span><span class="font-bold">\${session.uptime || session.duration || 'متصل الآن'}</span></div>
          \`;
        })
        .catch(() => {
          sesBox.innerHTML = '<div class="p-4 text-center text-red-500 text-xs font-bold">تعذر جلب تفاصيل الجلسة.</div>';
        });
    }

    // ==========================================
    // إدارة الوكلاء الثانويين
    // ==========================================
    async function loadSubAgents() {
      const res = await fetch('/api/admin/sub-agents');
      state.subAgents = await res.json();

      // تحديث القائمة المنسدلة للتحويل
      const select = document.getElementById('assign-agent-select');
      select.innerHTML = '<option value="">-- اختر الوكيل الثانوي --</option><option value="unassign">إلغاء التعيين (إرجاع للرئيسي)</option>' +
        state.subAgents.map(a => \`<option value="\${a.id}">\${a.name} (\${a.subscriber_count} مشترك)</option>\`).join('');

      // تحديث الجدول
      const tbody = document.getElementById('agents-tbody');
      if (state.subAgents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-slate-400">لم يتم إضافة وكلاء ثانويين بعد.</td></tr>';
        return;
      }
      tbody.innerHTML = state.subAgents.map(a => \`
        <tr>
          <td class="p-3 font-bold">\${a.name}</td>
          <td class="p-3 font-mono text-xs">\${a.username}</td>
          <td class="p-3 font-mono text-xs">\${a.phone || '-'}</td>
          <td class="p-3 text-center"><span class="px-2.5 py-1 rounded-full bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300 font-bold text-xs">\${a.subscriber_count}</span></td>
          <td class="p-3 text-center">
            <button onclick="deleteSubAgent(\${a.id})" class="text-red-500 hover:underline text-xs font-bold">حذف</button>
          </td>
        </tr>
      \`).join('');
    }

    document.getElementById('add-agent-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('agent-name').value.trim();
      const username = document.getElementById('agent-username').value.trim();
      const password = document.getElementById('agent-password').value;
      const phone = document.getElementById('agent-phone').value.trim();

      try {
        const res = await fetch('/api/admin/sub-agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, username, password, phone })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        e.target.reset();
        showToast('تم إنشاء حساب الوكيل الثانوي بنجاح', 'success');
        await loadSubAgents();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    async function deleteSubAgent(id) {
      if (!confirm('هل أنت متأكد من حذف هذا الوكيل؟')) return;
      await fetch(\`/api/admin/sub-agents/\${id}\`, { method: 'DELETE' });
      showToast('تم حذف الوكيل', 'info');
      await fetchAllData();
    }

    async function assignSelectedSubscribers() {
      const sub_agent_id = document.getElementById('assign-agent-select').value;
      if (!sub_agent_id) {
        showToast('يرجى اختيار الوكيل الثانوي أولاً', 'error');
        return;
      }

      try {
        const res = await fetch('/api/admin/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sub_agent_id,
            subscription_ids: Array.from(state.selectedIds)
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        state.selectedIds.clear();
        updateAssignBar();
        showToast(data.message, 'success');
        await fetchAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ==========================================
    // المحفظة والحركات المالية
    // ==========================================
    async function loadFinance() {
      try {
        const res = await fetch('/api/ftth/finance', { headers: { 'x-ftth-token': state.token } });
        const data = await res.json();

        const bal = data.wallet?.balance ?? data.wallet?.availableBalance ?? 0;
        document.getElementById('wallet-balance').textContent = \`\${Number(bal).toLocaleString()} IQD\`;

        state.transactions = data.transactions || [];
        const cardCount = state.transactions.filter(t => (t.paymentMode || '').toLowerCase() === 'card').length;
        const walletCount = state.transactions.filter(t => (t.paymentMode || '').toLowerCase() === 'wallet').length;

        document.getElementById('card-payments-count').textContent = \`\${cardCount} عملية\`;
        document.getElementById('wallet-payments-count').textContent = \`\${walletCount} عملية\`;
        renderTransactions();
      } catch (e) { console.error(e); }
    }

    function renderTransactions() {
      const filter = document.getElementById('payment-mode-filter').value;
      const tbody = document.getElementById('transactions-tbody');

      const filtered = state.transactions.filter(tx => {
        if (filter === 'all') return true;
        return (tx.paymentMode || '').toLowerCase() === filter.toLowerCase();
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-400">لا توجد حركات مالية مطابقة.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(tx => {
        const mode = tx.paymentMode || 'Wallet';
        const isCard = mode.toLowerCase() === 'card';
        const modeBadge = isCard
          ? '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">دفع المشترك (Card)</span>'
          : '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700">دفع الوكيل (Wallet)</span>';

        return \`
          <tr>
            <td class="p-3 text-xs font-mono">\${tx.createdAt ? new Date(tx.createdAt).toLocaleString('ar-IQ') : '-'}</td>
            <td class="p-3 font-bold">\${tx.description || tx.customerName || tx.type || 'عملية مالية'}</td>
            <td class="p-3">\${modeBadge}</td>
            <td class="p-3 font-extrabold font-mono" dir="ltr">\${Number(tx.amount || 0).toLocaleString()} IQD</td>
          </tr>
        \`;
      }).join('');
    }

    // ==========================================
    // الدعم الفني ومهام التنصيب
    // ==========================================
    async function loadOperations() {
      try {
        const res = await fetch('/api/ftth/operations', { headers: { 'x-ftth-token': state.token } });
        const data = await res.json();

        const ticketsBox = document.getElementById('tickets-list');
        const requestsBox = document.getElementById('requests-list');

        ticketsBox.innerHTML = (data.tickets || []).length === 0
          ? '<p class="text-sm text-slate-400 text-center py-4">لا توجد تذاكر دعم فني حالياً.</p>'
          : data.tickets.slice(0, 15).map(t => \`
            <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 flex justify-between items-center">
              <div>
                <div class="font-bold text-sm">\${t.subject || t.title || 'تذكرة دعم'}</div>
                <div class="text-xs text-slate-500">\${t.customerName || ''} • \${t.status || 'مفتوحة'}</div>
              </div>
              <span class="text-xs font-mono bg-white dark:bg-slate-900 px-2 py-1 rounded border">#\${t.id || ''}</span>
            </div>
          \`).join('');

        requestsBox.innerHTML = (data.requests || []).length === 0
          ? '<p class="text-sm text-slate-400 text-center py-4">لا توجد مهام تنصيب حالياً.</p>'
          : data.requests.slice(0, 15).map(r => \`
            <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 flex justify-between items-center">
              <div>
                <div class="font-bold text-sm">\${r.customerName || r.title || 'طلب تنصيب جديد'}</div>
                <div class="text-xs text-slate-500">\${r.zoneName || ''} • \${r.status || 'قيد التنفيذ'}</div>
              </div>
              <span class="text-xs font-mono bg-white dark:bg-slate-900 px-2 py-1 rounded border">#\${r.id || ''}</span>
            </div>
          \`).join('');
      } catch (e) { console.error(e); }
    }
  </script>
</body>
</html>`;

// تقديم الواجهة الأمامية المدمجة لجميع المسارات غير الـ API
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML_TEMPLATE);
});

// تشغيل الخادم
app.listen(PORT, '0.0.0.0', () => {
  console.log(\`🚀 خادم مركز وار لخدمات الإنترنت يعمل على المنفذ: \${PORT}\`);
});
