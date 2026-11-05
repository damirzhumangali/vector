#!/bin/sh
set -eu

backend_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config_file=${QWORK_ENV_FILE:-"$backend_dir/.env.local"}

fail() {
    printf '%s\n' "$1" >&2
    exit 2
}

[ "$#" -le 1 ] || fail 'Usage: backend/run-local.sh [--check]'
case "${1:-}" in
    ''|--check) ;;
    *) fail 'Usage: backend/run-local.sh [--check]' ;;
esac

# Parse literal values rather than sourcing a file containing shell code.
# Never print configuration values: they may include passwords and API keys.
if [ -f "$config_file" ]; then
    line_number=0
    carriage_return=$(printf '\r')
    while IFS= read -r line || [ -n "$line" ]; do
        line_number=$((line_number + 1))
        line=${line%"$carriage_return"}
        case "$line" in
            ''|\#*) continue ;;
            *=*) key=${line%%=*}; value=${line#*=} ;;
            *) fail "Invalid config entry at line $line_number. Use KEY=value." ;;
        esac
        case "$key" in
            QWORK_HOST|QWORK_PORT|QWORK_DB|QWORK_DATABASE_URL|QWORK_EMAIL_PROVIDER|QWORK_EMAIL_API_KEY|QWORK_EMAIL_FROM|QWORK_PUBLIC_URL|QWORK_EMAIL_API_URL|QWORK_TRUST_PROXY) ;;
            *) fail "Unsupported config key at line $line_number." ;;
        esac
        case "$value" in
            \"*\") value=${value#\"}; value=${value%\"} ;;
            \'*\') value=${value#\'}; value=${value%\'} ;;
            \"*|\'*) fail "Unclosed quote at config line $line_number." ;;
        esac
        export "$key=$value"
    done < "$config_file"
elif [ -n "${QWORK_ENV_FILE:-}" ]; then
    fail 'The specified QWORK_ENV_FILE does not exist.'
fi

QWORK_HOST=${QWORK_HOST:-0.0.0.0}
QWORK_PORT=${QWORK_PORT:-${PORT:-8787}}
QWORK_DB=${QWORK_DB:-"$backend_dir/data/qwork.sqlite3"}
case "$QWORK_DB" in
    /*) ;;
    *) QWORK_DB="$backend_dir/$QWORK_DB" ;;
esac
export QWORK_HOST QWORK_PORT QWORK_DB

case "$QWORK_PORT" in
    ''|*[!0-9]*) fail 'QWORK_PORT must be a valid TCP port.' ;;
esac
[ "${#QWORK_PORT}" -le 5 ] && [ "$QWORK_PORT" -ge 1 ] && [ "$QWORK_PORT" -le 65535 ] \
    || fail 'QWORK_PORT must be a valid TCP port.'

mail_fields=0
case "${QWORK_EMAIL_PROVIDER:-resend}" in
    brevo|resend) ;;
    *) fail 'QWORK_EMAIL_PROVIDER must be brevo or resend.' ;;
esac
[ -z "${QWORK_EMAIL_API_KEY:-}" ] || mail_fields=$((mail_fields + 1))
[ -z "${QWORK_EMAIL_FROM:-}" ] || mail_fields=$((mail_fields + 1))
[ -z "${QWORK_PUBLIC_URL:-}" ] || mail_fields=$((mail_fields + 1))
case "$mail_fields" in
    0) mail_state=absent ;;
    3)
        case "$QWORK_PUBLIC_URL" in
            https://?*) ;;
            *) fail 'QWORK_PUBLIC_URL must use HTTPS.' ;;
        esac
        mail_state=present
        ;;
    *) fail 'Set QWORK_EMAIL_API_KEY, QWORK_EMAIL_FROM and QWORK_PUBLIC_URL together, or leave all three empty.' ;;
esac

[ -f "$backend_dir/target/qwork-api.jar" ] \
    || fail 'Build the API first: mvn -f backend/pom.xml package'
command -v java >/dev/null 2>&1 || fail 'Install JDK 21 or newer to run the API.'
command -v cwebp >/dev/null 2>&1 || fail 'Install cwebp from the webp package and make it available in PATH.'

if [ "${1:-}" = '--check' ]; then
    printf 'API build: present\nMail settings: %s\n' "$mail_state"
    printf '%s\n' 'Configuration values are hidden. No network or delivery check was performed.'
    exit 0
fi

cd -- "$backend_dir"
exec java -jar "$backend_dir/target/qwork-api.jar"
