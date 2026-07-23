#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_ROOT="/app"
readonly APP_USER="simplechat"
readonly REPOSITORY_DIR="${APP_ROOT}/repository"
readonly RELEASES_DIR="${APP_ROOT}/releases"
readonly SHARED_ENV="${APP_ROOT}/shared/.env"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly BRANCH="main"
readonly CADDY_PLACEHOLDER='{$SITE_ADDRESS:http://localhost}'

atomic_symlink() {
    local target="$1"
    local link="$2"
    local temporary_link="${link}.next.$$"

    ln -s "${target}" "${temporary_link}"
    mv -Tf "${temporary_link}" "${link}"
}

read_env_value() {
    local key="$1"
    sed -n "s/^${key}=//p" "${SHARED_ENV}" | tail -n 1
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

if [[ ! -d "${REPOSITORY_DIR}/.git" || ! -d "${RELEASES_DIR}" ]]; then
    echo "The atomic release layout is missing; run the current setup.sh first." >&2
    exit 1
fi

if [[ ! -L "${CURRENT_LINK}" || ! -f "${SHARED_ENV}" ]]; then
    echo "The current release link or shared environment is missing." >&2
    exit 1
fi

previous_release="$(readlink -f "${CURRENT_LINK}")"
case "${previous_release}" in
    "${RELEASES_DIR}"/*) ;;
    *)
        echo "The current release points outside ${RELEASES_DIR}." >&2
        exit 1
        ;;
esac

if [[ -n "$(runuser -u "${APP_USER}" -- \
    git -C "${REPOSITORY_DIR}" status --porcelain)" ]]; then
    echo "Refusing to update because the repository contains local changes." >&2
    exit 1
fi

runuser -u "${APP_USER}" -- git -C "${REPOSITORY_DIR}" fetch origin "${BRANCH}"
target_sha="$(runuser -u "${APP_USER}" -- \
    git -C "${REPOSITORY_DIR}" rev-parse "origin/${BRANCH}")"
current_sha="$(runuser -u "${APP_USER}" -- \
    git -C "${previous_release}" rev-parse HEAD)"

if [[ ${target_sha} == "${current_sha}" ]]; then
    echo "SimpleChat is already running ${target_sha}."
    exit 0
fi

release_id="$(date -u +%Y%m%d%H%M%S)-${target_sha:0:12}"
release_dir="${RELEASES_DIR}/${release_id}"
if [[ -e "${release_dir}" ]]; then
    echo "Release directory ${release_dir} already exists." >&2
    exit 1
fi

echo "Preparing release ${release_id}"
runuser -u "${APP_USER}" -- git -C "${REPOSITORY_DIR}" \
    worktree add --detach "${release_dir}" "${target_sha}"
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" \
    ci --omit=dev --ignore-scripts
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" run check
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" test
runuser -u "${APP_USER}" -- ln -s "${SHARED_ENV}" "${release_dir}/.env"
runuser -u "${APP_USER}" -- npm --prefix "${release_dir}" run validate-config

site_address="$(read_env_value SITE_ADDRESS)"
if [[ ! ${site_address} =~ ^([A-Za-z0-9.-]+|http://localhost(:[0-9]+)?)$ ]]; then
    echo "SITE_ADDRESS in ${SHARED_ENV} is invalid." >&2
    exit 1
fi

temporary_caddyfile="$(mktemp)"
backup_dir="$(mktemp -d)"
trap 'rm -f "${temporary_caddyfile}" "${backup_dir}/Caddyfile" \
    "${backup_dir}/simplechat.service"; rmdir "${backup_dir}" 2>/dev/null || true' EXIT

sed "s|${CADDY_PLACEHOLDER}|${site_address}|g" \
    "${release_dir}/Caddyfile" > "${temporary_caddyfile}"
caddy validate --config "${temporary_caddyfile}"
cp -a /etc/caddy/Caddyfile "${backup_dir}/Caddyfile"
cp -a /etc/systemd/system/simplechat.service "${backup_dir}/simplechat.service"

activate_release() {
    atomic_symlink "${release_dir}" "${CURRENT_LINK}" || return 1
    install -o root -g root -m 0644 \
        "${temporary_caddyfile}" /etc/caddy/Caddyfile || return 1
    install -o root -g root -m 0644 \
        "${release_dir}/simplechat.service" \
        /etc/systemd/system/simplechat.service || return 1
    systemctl daemon-reload || return 1
    systemctl restart simplechat.service || return 1
    systemctl reload caddy.service || return 1
    wait_for_readiness
}

rollback_release() {
    echo "Activation failed; rolling back to ${previous_release}." >&2
    set +e
    atomic_symlink "${previous_release}" "${CURRENT_LINK}"
    cp -a "${backup_dir}/Caddyfile" /etc/caddy/Caddyfile
    cp -a "${backup_dir}/simplechat.service" /etc/systemd/system/simplechat.service
    systemctl daemon-reload
    systemctl restart simplechat.service
    systemctl reload caddy.service
    wait_for_readiness
}

if ! activate_release; then
    rollback_release
    exit 1
fi

echo "SimpleChat release ${release_id} is active and ready."
