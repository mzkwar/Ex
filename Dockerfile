FROM node:20-slim

WORKDIR /app

# نسخ ملفات الحزم أولاً
COPY package*.json ./

# تثبيت الحزم (بما فيها أدوات البناء التلقائية لـ sqlite3)
RUN npm install --production

# نسخ باقي ملفات المشروع
COPY . .

# فتح المنفذ الافتراضي لـ Render
EXPOSE 10000

# تشغيل الخادم
CMD ["npm", "start"]
