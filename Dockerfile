FROM node:22-alpine

WORKDIR /app

# Instalar cliente MariaDB (mysqldump) para os backups
RUN apk add --no-cache mariadb-client tzdata

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p public/uploads storage/tmp

EXPOSE 3000

CMD ["sh", "-c", "npx sequelize-cli db:migrate && node app.js"]
