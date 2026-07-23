#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_ROOT="/app"
readonly APP_USER="simplechat"
readonly REPOSITORY_DIR="${APP_ROOT}/repository"
readonly RELEASES_DIR="${APP_ROOT}/releases"
readonly SHARED_DIR="${APP_ROOT}/shared"
readonly SHARED_ENV="${SHARED_DIR}/.env"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly REPOSITORY_URL="https://github.com/tmatejicek/simpleChat.git"
readonly CADDY_PLACEHOLDER='{$SITE_ADDRESS:http://localhost}'

atomic_symlink() {
    local target="$1"
    local link="$2"
    local temporary_link="${link}.next.$$"

    ln -s "${target}" "${temporary_link}"
    mv -Tf "${temporary_link}" "${link}"
}

wait_for_readiness() {
    local attempt
    for attempt in {1..15}; do
        if curl --fail --silent --show-error --max-time 2 \
            "http://127.0.0.1:8080/readyz" >/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

if [[ ${EUID} -ne 0 ]]; then
    echo "Run this script as root." >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer supports Debian/Ubuntu systems with apt-get." >&2
    exit 1
fi

if [[ -e "${APP_ROOT}/.git" ]]; then
    echo "A legacy /app checkout exists; back it up and reinstall into the release layout." >&2
    exit 1
fi

if [[ -e "${REPOSITORY_DIR}" || -e "${CURRENT_LINK}" ]]; then
    echo "${APP_ROOT} already contains a SimpleChat release layout." >&2
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
    useradd --system --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 \
    "${APP_ROOT}" "${RELEASES_DIR}" "${SHARED_DIR}"
runuser -u "${APP_USER}" -- git clone "${REPOSITORY_URL}" "${REPOSITORY_DIR}"

target_sha="$(runuser -u "${APP_USER}" -- git -C "${REPOSITORY_DIR}" rev-parse HEAD)"
release_id="$(date -u +%Y%m%d%H%M%S)-${target_sha:0:12}"
release_dir="${RELEASES_DIR}/${release_id}"
runuser -u "${APP_USER}" -- git -C "${REPOSITORY_DIR}" \
    worktree add --detach "${release_dir}" "${target_sha}"
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" \
    ci --omit=dev --ignore-scripts
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" run check
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" test

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

read -r -p "Allowed browser origins (blank derives it from the site address): " allowed_origins
if [[ -z ${allowed_origins} ]]; then
    if [[ ${site_address} == http://* ]]; then
        allowed_origins="${site_address}"
    else
        allowed_origins="https://${site_address}"
    fi
fi
if [[ ! ${allowed_origins} =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(,https?://[A-Za-z0-9.-]+(:[0-9]+)?)*$ ]]; then
    echo "Allowed origins must be comma-separated HTTP(S) origins without paths." >&2
    exit 1
fi

umask 077
{
    printf 'NODE_ENV=production\n'
    printf 'JWT_SECRET=%s\n' "${jwt_secret}"
    printf 'HOST=127.0.0.1\n'
    printf 'PORT=8080\n'
    printf 'ALLOWED_ORIGINS=%s\n' "${allowed_origins}"
    printf 'SITE_ADDRESS=%s\n' "${site_address}"
} > "${SHARED_ENV}"
chown "${APP_USER}:${APP_USER}" "${SHARED_ENV}"
chmod 0600 "${SHARED_ENV}"
unset jwt_secret
runuser -u "${APP_USER}" -- ln -s "${SHARED_ENV}" "${release_dir}/.env"
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" run validate-config

temporary_caddyfile="$(mktemp)"
backup_dir="$(mktemp -d)"
trap 'rm -f "${temporary_caddyfile}" "${backup_dir}/Caddyfile" \
    "${backup_dir}/simplechat.service"; rmdir "${backup_dir}" 2>/dev/null || true' EXIT
sed "s|${CADDY_PLACEHOLDER}|${site_address}|g" \
    "${release_dir}/Caddyfile" > "${temporary_caddyfile}"
caddy validate --config "${temporary_caddyfile}"

had_caddyfile=false
had_service=false
if [[ -e /etc/caddy/Caddyfile ]]; then
    cp -a /etc/caddy/Caddyfile "${backup_dir}/Caddyfile"
    had_caddyfile=true
fi
if [[ -e /etc/systemd/system/simplechat.service ]]; then
    cp -a /etc/systemd/system/simplechat.service "${backup_dir}/simplechat.service"
    had_service=true
fi

activate_initial_release() {
    atomic_symlink "${release_dir}" "${CURRENT_LINK}" || return 1
    install -o root -g root -m 0644 \
        "${temporary_caddyfile}" /etc/caddy/Caddyfile || return 1
    install -o root -g root -m 0644 \
        "${release_dir}/simplechat.service" \
        /etc/systemd/system/simplechat.service || return 1
    systemctl daemon-reload || return 1
    systemctl enable simplechat.service || return 1
    systemctl restart simplechat.service || return 1
    systemctl reload caddy.service || return 1
    wait_for_readiness
}

if ! activate_initial_release; then
    echo "Deployment failed; restoring previous system configuration." >&2
    set +e
    systemctl disable --now simplechat.service
    rm -f "${CURRENT_LINK}"
    if ${had_caddyfile}; then
        cp -a "${backup_dir}/Caddyfile" /etc/caddy/Caddyfile
    fi
    if ${had_service}; then
        cp -a "${backup_dir}/simplechat.service" /etc/systemd/system/simplechat.service
    else
        rm -f /etc/systemd/system/simplechat.service
    fi
    systemctl daemon-reload
    systemctl reload caddy.service
    exit 1
fi

echo "SimpleChat release ${release_id} is installed and ready."
