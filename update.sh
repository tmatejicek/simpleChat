#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/app"
readonly APP_USER="simplechat"
readonly BRANCH="main"
readonly CADDY_PLACEHOLDER='{$SITE_ADDRESS:http://localhost}'

if [[ ${EUID} -ne 0 ]]; then
    echo "Run this script as root." >&2
    exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
    echo "${APP_DIR} is not a Git checkout." >&2
    exit 1
fi

if [[ -n "$(runuser -u "${APP_USER}" -- git -C "${APP_DIR}" status --porcelain)" ]]; then
    echo "Refusing to update because ${APP_DIR} contains local changes." >&2
    exit 1
fi

runuser -u "${APP_USER}" -- git -C "${APP_DIR}" fetch origin "${BRANCH}"
runuser -u "${APP_USER}" -- git -C "${APP_DIR}" merge --ff-only "origin/${BRANCH}"
runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" ci --omit=dev --ignore-scripts

site_address="$(sed -n 's/^SITE_ADDRESS=//p' "${APP_DIR}/.env" | tail -n 1)"
if [[ ! ${site_address} =~ ^([A-Za-z0-9.-]+|http://localhost(:[0-9]+)?)$ ]]; then
    echo "SITE_ADDRESS in ${APP_DIR}/.env is invalid." >&2
    exit 1
fi

temporary_caddyfile="$(mktemp)"
trap 'rm -f "${temporary_caddyfile}"' EXIT
sed "s|${CADDY_PLACEHOLDER}|${site_address}|g" \
    "${APP_DIR}/Caddyfile" > "${temporary_caddyfile}"
caddy validate --config "${temporary_caddyfile}"
install -o root -g root -m 0644 "${temporary_caddyfile}" /etc/caddy/Caddyfile
install -o root -g root -m 0644 \
    "${APP_DIR}/simplechat.service" /etc/systemd/system/simplechat.service

systemctl daemon-reload
systemctl restart simplechat.service
systemctl reload caddy.service

echo "SimpleChat was updated successfully."
