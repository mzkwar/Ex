FROM node:20-alpine

# تثبيت أدوات البناء اللازمة لمكتبة sqlite3 على بيئة Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app

# نسخ ملفات الحزم وتثبيتها
COPY package*.json ./
RUN npm install --production

# نسخ كود التطبيق
COPY . .

# فتح المنفذ الافتراضي لـ Render
EXPOSE 10000

# تشغيل الخادم
CMD ["npm", "start"]
