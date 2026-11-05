#!/bin/sh
set -eu
umask 077

usage() {
    printf '%s\n' 'Usage: postgres-backup.sh backup <new.dump>' \
        '       postgres-backup.sh restore <existing.dump> <qwork_restore_name>' >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
action=$1
archive=$2
case "$archive" in
    /*) ;;
    *) archive="$PWD/$archive" ;;
esac

backend_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

compose_db() {
    if [ -n "${COMPOSE_FILE:-}" ]; then
        docker compose exec -T db "$@"
    else
        docker compose --project-directory "$backend_dir" \
            -f "$backend_dir/compose.yaml" -f "$backend_dir/compose.postgres.yaml" \
            exec -T db "$@"
    fi
}

case "$action" in
    backup)
        [ "$#" -eq 2 ] || usage
        if [ -e "$archive" ] || [ -L "$archive" ]; then
            printf 'Backup destination already exists: %s\n' "$archive" >&2
            exit 1
        fi
        temporary=$(mktemp "${archive}.partial.XXXXXX")
        trap 'rm -f -- "$temporary"' EXIT
        trap 'exit 1' HUP INT TERM
        compose_db sh -ec 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$temporary"
        compose_db pg_restore --list <"$temporary" >/dev/null
        ln -- "$temporary" "$archive"
        printf 'Backup saved to %s\n' "$archive"
        ;;
    restore)
        [ "$#" -eq 3 ] || usage
        destination=$3
        case "$destination" in
            qwork_restore_?*) ;;
            *) usage ;;
        esac
        case "$destination" in
            *[!a-z0-9_]*) usage ;;
        esac
        [ "${#destination}" -le 63 ] || usage
        [ -f "$archive" ] && [ -r "$archive" ] || usage
        compose_db pg_restore --list <"$archive" >/dev/null
        compose_db sh -ec 'exec createdb -U "$POSTGRES_USER" -- "$1"' sh "$destination"
        if ! compose_db sh -ec '
            exec pg_restore --single-transaction --no-owner --no-privileges \
                -U "$POSTGRES_USER" -d "$1"
        ' sh "$destination" <"$archive"; then
            compose_db sh -ec 'exec dropdb -U "$POSTGRES_USER" -- "$1"' sh "$destination"
            exit 1
        fi
        printf 'Restored into database %s\n' "$destination"
        ;;
    *) usage ;;
esac
