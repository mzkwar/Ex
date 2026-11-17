const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// صفحة الـ HTML المدمجة مع تأكيد استمرار حالة التحميل لحين الاكتمال
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>إدارة المشتركين وتصدير Excel - مركز وار</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        darkBg: '#0f172a',
                        cardDark: '#1e293b',
                        lightBg: '#f8fafc',
                        cardLight: '#ffffff'
                    }
                }
            }
        }
    </script>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
    <style> body { font-family: 'Tajawal', sans-serif; } </style>
</head>
<body class="bg-lightBg text-slate-800 dark:bg-darkBg dark:text-slate-100 min-h-screen flex flex-col">

    <div id="toast-container" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 space-y-2 pointer-events-none"></div>

    <!-- شاشة تسجيل الدخول -->
    <div id="login-screen" class="min-h-screen flex items-center justify-center p-4">
        <div class="bg-cardLight dark:bg-cardDark border border-slate-200 dark:border-slate-700 p-8 rounded-3xl shadow-2xl w-full max-w-md space-y-6">
            <div class="text-center space-y-2">
                <div class="w-16 h-16 bg-indigo-600 rounded-2xl mx-auto flex items-center justify-center shadow-lg">
                    <span class="text-white text-3xl font-black">W</span>
                </div>
                <h2 class="text-2xl font-extrabold text-indigo-600 dark:text-indigo-400">مركز وار لخدمات الإنترنت</h2>
                <p class="text-sm text-slate-500 dark:text-slate-400">سجّل دخولك للوصول إلى قاعدة بيانات المشتركين وتصدير Excel</p>
            </div>
            <form id="login-form" class="space-y-4">
                <div>
                    <label class="block text-xs font-bold mb-1">اسم المستخدم / البريد</label>
                    <input type="text" id="ftth-email" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-base focus:outline-none focus:border-indigo-500" required>
                </div>
                <div>
                    <label class="block text-xs font-bold mb-1">كلمة المرور</label>
                    <input type="password" id="ftth-password" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-base focus:outline-none focus:border-indigo-500" required>
                </div>
                <button type="submit" id="login-btn" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-3.5 rounded-xl font-bold text-base shadow-lg transition">دخول النظام</button>
            </form>
        </div>
    </div>

    <!-- لوحة التحكم وعرض المشتركين -->
    <div id="dashboard-screen" class="hidden flex-1 flex flex-col">
        <header class="bg-cardLight dark:bg-cardDark border-b border-slate-200 dark:border-slate-700 sticky top-0 z-40 p-4 flex justify-between items-center shadow-md">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-black text-lg">W</div>
                <div>
                    <h1 class="text-base font-extrabold">قاعدة بيانات المشتركين (الاسم - الهاتف - الزون - الفات)</h1>
                </div>
            </div>
            <div class="flex items-center gap-2">
                <button onclick="exportToExcel()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-xl text-xs font-extrabold shadow flex items-center gap-1 transition">
                    <span>📥 تنزيل Excel</span>
                </button>
                <button onclick="logout()" class="bg-rose-500/10 text-rose-500 border border-rose-500/20 px-3.5 py-2 rounded-xl text-xs font-bold">خروج</button>
            </div>
        </header>

        <main class="p-4 max-w-6xl mx-auto w-full space-y-4 flex-1">
            <div class="bg-cardLight dark:bg-cardDark p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-3">
                <div class="w-full sm:flex-1">
                    <input type="text" id="search-input" oninput="filterSubscribers()" placeholder="🔍 ابحث باسم المشترك، رقم الهاتف، الزون، أو الفات..." class="w-full bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-sm font-semibold focus:outline-none focus:border-indigo-500">
                </div>
                <div class="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                    <span id="total-badge" class="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 px-3.5 py-2 rounded-xl text-xs font-extrabold whitespace-nowrap">العدد: 0</span>
                    <button onclick="loadSubscribers()" class="bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 px-3.5 py-2 rounded-xl text-xs font-bold transition">تحديث 🔄</button>
                </div>
            </div>

            <div class="bg-cardLight dark:bg-cardDark rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div class="overflow-x-auto">
                    <table class="w-full text-right text-sm">
                        <thead class="bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 font-bold border-b border-slate-200 dark:border-slate-700">
                            <tr>
                                <th class="p-4">#</th>
                                <th class="p-4">اسم المشترك</th>
                                <th class="p-4">رقم الهاتف</th>
                                <th class="p-4">الزون (Zone)</th>
                                <th class="p-4">الفات (FAT)</th>
                            </tr>
                        </thead>
                        <tbody id="subscribers-tbody" class="divide-y divide-slate-200 dark:divide-slate-700/60 font-medium">
                            <tr><td colspan="5" class="p-12 text-center text-indigo-500 font-bold animate-pulse text-base">⏳ جاري سحب وتحميل بيانات المشتركين من المنظومة... يرجى الانتظار لحين الاكتمال</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
    </div>

    <script>
        let authToken = localStorage.getItem('ftth_token') || '';
        let allSubscribers = [];
        let filteredSubscribers = [];

        window.addEventListener('DOMContentLoaded', () => {
            if (authToken) {
                document.getElementById('login-screen').classList.add('hidden');
                document.getElementById('dashboard-screen').classList.remove('hidden');
                loadSubscribers();
            }
        });

        function showToast(message, type = 'info') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = \`pointer-events-auto px-4 py-3 rounded-xl shadow-2xl text-xs font-extrabold text-white transition-all duration-300 \${type === 'error' ? 'bg-rose-600' : 'bg-indigo-600'}\`;
            toast.innerText = message;
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 3500);
        }

        function extractVal(field) {
            if (!field && field !== 0) return '';
            if (typeof field === 'object') {
                return field.displayValue || field.name || field.title || field.code || field.id || '';
            }
            return String(field);
        }

        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('login-btn');
            btn.innerText = 'جاري التحقق...';
            btn.disabled = true;

            try {
                const res = await fetch('/api/ftth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: document.getElementById('ftth-email').value,
                        password: document.getElementById('ftth-password').value
                    })
                });
                const data = await res.json();
                const rawToken = data.access_token || data.token || data.accessToken || (typeof data === 'string' ? data : null);

                if (res.ok && rawToken) {
                    authToken = rawToken.startsWith('Bearer ') ? rawToken : \`Bearer \${rawToken}\`;
                    localStorage.setItem('ftth_token', authToken);
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('dashboard-screen').classList.remove('hidden');
                    loadSubscribers();
                } else {
                    showToast(data.message || "فشل تسجيل الدخول", "error");
                    btn.innerText = 'دخول النظام';
                    btn.disabled = false;
                }
            } catch (err) {
                showToast("خطأ في الاتصال بالخادم", "error");
                btn.innerText = 'دخول النظام';
                btn.disabled = false;
            }
        });

        async function loadSubscribers() {
            const tbody = document.getElementById('subscribers-tbody');
            // استمرار إظهار شاشة التحميل لحين الاكتمال التام
            tbody.innerHTML = '<tr><td colspan="5" class="p-12 text-center text-indigo-500 font-bold animate-pulse text-base">⏳ جاري سحب وتحميل بيانات المشتركين من المنظومة... يرجى الانتظار لحين الاكتمال</td></tr>';

            try {
                const res = await fetch('/api/ftth/subscribers-all', {
                    headers: { 'Authorization': authToken }
                });

                if (res.status === 401) {
                    showToast("انتهت الجلسة، يرجى إعادة تسجيل الدخول", "error");
                    logout();
                    return;
                }

                if (!res.ok) throw new Error('فشل الجلب من الخادم');

                const data = await res.json();
                
                if (!Array.isArray(data) || data.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-amber-500 font-bold">لا توجد بيانات متاحة حالياً أو أن الحساب لا يملك مشتركين مسجلين.</td></tr>';
                    return;
                }

                allSubscribers = data.map(sub => {
                    const name = extractVal(sub.customer) || extractVal(sub.subscriber) || 'غير محدد';
                    const phone = sub.phone || sub.mobile || sub.customer?.phone || sub.customer?.mobile || 'غير مسجل';
                    const zone = extractVal(sub.zone) || extractVal(sub.deviceDetails?.zone) || 'غير محدد';
                    const fat = extractVal(sub.fat) || extractVal(sub.deviceDetails?.fat) || 'غير محدد';
                    
                    return { name, phone, zone, fat };
                });

                filteredSubscribers = [...allSubscribers];
                renderTable(filteredSubscribers);
                showToast(\`تم تحميل \${allSubscribers.length} مشترك بنجاح\`);
            } catch (err) {
                tbody.innerHTML = '<tr><td colspan="5" class="p-12 text-center text-rose-500 font-bold text-base">❌ تعذر جلب البيانات من المنظومة. يرجى إعادة المحاولة أو تسجيل الدخول من جديد.</td></tr>';
                showToast("تعذر جلب البيانات", "error");
            }
        }

        function renderTable(list) {
            const tbody = document.getElementById('subscribers-tbody');
            const badge = document.getElementById('total-badge');
            badge.innerText = \`العدد: \${list.length} / الكلي: \${allSubscribers.length}\`;
            tbody.innerHTML = '';

            if (list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 font-bold">لا توجد نتائج مطابقة للبحث</td></tr>';
                return;
            }

            list.forEach((item, index) => {
                tbody.innerHTML += \`
                    <tr class="hover:bg-slate-100 dark:hover:bg-slate-800/60 transition">
                        <td class="p-4 text-xs text-slate-400 font-mono">\${index + 1}</td>
                        <td class="p-4 font-bold text-indigo-600 dark:text-indigo-400">\${item.name}</td>
                        <td class="p-4 font-mono dir-ltr text-right">
                            \${item.phone !== 'غير مسجل' ? \`<a href="tel:\${item.phone}" class="text-emerald-500 font-bold hover:underline">\${item.phone}</a>\` : '<span class="text-slate-400 text-xs">غير مسجل</span>'}
                        </td>
                        <td class="p-4 font-bold text-slate-700 dark:text-slate-200">\${item.zone}</td>
                        <td class="p-4 font-mono font-bold text-amber-600 dark:text-amber-400">\${item.fat}</td>
                    </tr>
                \`;
            });
        }

        function filterSubscribers() {
            const q = document.getElementById('search-input').value.trim().toLowerCase();
            if (!q) {
                filteredSubscribers = [...allSubscribers];
            } else {
                filteredSubscribers = allSubscribers.filter(s => 
                    s.name.toLowerCase().includes(q) ||
                    s.phone.toLowerCase().includes(q) ||
                    s.zone.toLowerCase().includes(q) ||
                    s.fat.toLowerCase().includes(q)
                );
            }
            renderTable(filteredSubscribers);
        }

        function exportToExcel() {
            if (filteredSubscribers.length === 0) return;
            const excelData = filteredSubscribers.map((item, idx) => ({
                'التسلسل': idx + 1,
                'اسم المشترك': item.name,
                'رقم الهاتف': item.phone,
                'الزون (Zone)': item.zone,
                'الفات (FAT)': item.fat
            }));

            const worksheet = XLSX.utils.json_to_sheet(excelData);
            worksheet['!cols'] = [{ wch: 8 }, { wch: 35 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'المشتركين');
            XLSX.writeFile(workbook, 'سجل_المشتركين.xlsx');
            showToast("تم تنزيل ملف Excel بنجاح!");
        }

        function logout() {
            localStorage.removeItem('ftth_token');
            location.reload();
        }
    </script>
</body>
</html>`);
});

// مسار فحص الصحة للإيقاظ (Keep-Alive)
app.get('/ping', (req, res) => {
    res.status(200).send('Server is alive!');
});

// مسار تسجيل الدخول
app.post('/api/ftth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'password');
        params.append('client_id', 'earthlink-portals');
        params.append('username', username);
        params.append('password', password);

        const response = await axios.post('https://admin.ftth.iq/api/auth/Contractor/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
        });
        res.json(response.data);
    } catch (error) {
        res.status(401).json({ message: "فشل تسجيل الدخول" });
    }
});

// مسار جلب المشتركين الكلي ودمج الهواتف
app.get('/api/ftth/subscribers-all', async (req, res) => {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "غير مرخص" });

    try {
        const headers = { 'Authorization': token, 'Accept': 'application/json' };
        
        const [subsRes, custsRes] = await Promise.all([
            axios.get('https://admin.ftth.iq/api/subscriptions?hierarchyLevel=0&pageSize=3000', { headers }),
            axios.get('https://admin.ftth.iq/api/customers?hierarchyLevel=1&pageSize=3000', { headers }).catch(() => ({ data: { items: [] } }))
        ]);

        const subs = Array.isArray(subsRes.data) ? subsRes.data : (subsRes.data.items || subsRes.data.data || []);
        const custs = Array.isArray(custsRes.data) ? custsRes.data : (custsRes.data.items || custsRes.data.data || []);

        const phoneMap = {};
        custs.forEach(c => {
            const id = c.id || c.customerId;
            const phone = c.primaryContact?.mobile || c.mobile || c.phone || c.contact?.mobile;
            if (id && phone) phoneMap[String(id)] = phone;
        });

        const enrichedSubs = subs.map(sub => {
            const custId = sub.customerId || (typeof sub.customer === 'object' ? sub.customer?.id : null);
            const foundPhone = (custId && phoneMap[String(custId)]) || sub.phone || sub.mobile || sub.customer?.phone || sub.customer?.mobile;
            return {
                ...sub,
                phone: foundPhone || 'غير مسجل'
            };
        });

        res.json(enrichedSubs);
    } catch (error) {
        res.status(500).json({ error: "تعذر جلب بيانات المشتركين" });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على Port ${PORT}`);
    
    // كود عدم النوم (Keep-Alive)
    const INTERVAL_TIME = 10 * 60 * 1000; 
    setInterval(() => {
        const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        axios.get(`${RENDER_URL}/ping`).catch(() => {});
    }, INTERVAL_TIME);
});
