#!/bin/bash

# 1. Instalace Node.js a NPM
echo "Installing Node.js and NPM"
apt update
apt upgrade -y
apt install -y nodejs npm

# 2. Instalace PM2
echo "Installing PM2"
npm install -g pm2

# 3. Instalace Caddy
echo "Installing Caddy"
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy

# 4. Stažení aplikace
echo "Cloning the app"
git clone https://github.com/tmatejicek/simpleChat /app

# 5. Instalace knihoven
echo "Installing app packages"
cd /app
npm install

# 6. Konfigurace aplikace
read -p "JWT_SECRETe: " JWT_SECRET
echo "JWT_SECRET=$JWT_SECRET" > /app/.env

# 7. Spuštění Aplikace
echo "Running app"
cd /app
pm2 start /app/app.js -u nobody --hp /app/
pm2 startup
pm2 save

# 8. Konfigurace a restart Caddy
echo "Running Caddy"
mv /app/Caddyfile /etc/caddy/Caddyfile
systemctl restart caddy

echo "Done"

