#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/app"
readonly APP_USER="simplechat"
readonly REPOSITORY_URL="https://github.com/tmatejicek/simpleChat.git"
readonly CADDY_PLACEHOLDER='{$SITE_ADDRESS:http://localhost}'

if [[ ${EUID} -ne 0 ]]; then
    echo "Run this script as root." >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer supports Debian/Ubuntu systems with apt-get." >&2
    exit 1
fi

echo "Installing system dependencies"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    debian-archive-keyring \
    debian-keyring \
    git \
    gnupg \
    nodejs \
    npm

node_major_version="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! ${node_major_version} =~ ^[0-9]+$ ]] || (( node_major_version < 20 )); then
    echo "Node.js 20 or newer is required; the distribution installed $(node --version)." >&2
    exit 1
fi

echo "Installing Caddy"
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor \
        -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y caddy

if ! id "${APP_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

if [[ -e "${APP_DIR}/.git" ]]; then
    echo "${APP_DIR} already contains a Git checkout; use update.sh instead." >&2
    exit 1
fi

install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${APP_DIR}"
runuser -u "${APP_USER}" -- git clone "${REPOSITORY_URL}" "${APP_DIR}"
runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" ci --omit=dev --ignore-scripts

read -r -s -p "JWT secret (at least 32 base64url characters): " jwt_secret
echo
if [[ ! ${jwt_secret} =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
    echo "JWT secret must contain at least 32 base64url-safe characters." >&2
    exit 1
fi

read -r -p "Caddy site address (for example chat.example.com): " site_address
if [[ ! ${site_address} =~ ^([A-Za-z0-9.-]+|http://localhost(:[0-9]+)?)$ ]]; then
    echo "Use a hostname for automatic HTTPS, or http://localhost for local use." >&2
    exit 1
fi

read -r -p "Allowed browser origins (comma-separated, optional): " allowed_origins
if [[ ${allowed_origins} == *$'\n'* || ${allowed_origins} == *$'\r'* ]]; then
    echo "Allowed origins must fit on one line." >&2
    exit 1
fi

umask 077
{
    printf 'JWT_SECRET=%s\n' "${jwt_secret}"
    printf 'HOST=127.0.0.1\n'
    printf 'PORT=8080\n'
    printf 'ALLOWED_ORIGINS=%s\n' "${allowed_origins}"
    printf 'SITE_ADDRESS=%s\n' "${site_address}"
} > "${APP_DIR}/.env"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 0600 "${APP_DIR}/.env"
unset jwt_secret

temporary_caddyfile="$(mktemp)"
trap 'rm -f "${temporary_caddyfile}"' EXIT
sed "s|${CADDY_PLACEHOLDER}|${site_address}|g" \
    "${APP_DIR}/Caddyfile" > "${temporary_caddyfile}"
caddy validate --config "${temporary_caddyfile}"
install -o root -g root -m 0644 "${temporary_caddyfile}" /etc/caddy/Caddyfile

install -o root -g root -m 0644 \
    "${APP_DIR}/simplechat.service" /etc/systemd/system/simplechat.service
systemctl daemon-reload
systemctl enable --now simplechat.service
systemctl reload caddy.service

echo "SimpleChat is installed and running."
