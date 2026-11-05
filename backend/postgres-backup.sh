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

mode=${QWORK_BACKUP_MODE:-compose}
case "$mode" in
    compose) ;;
    direct)
        : "${PGHOST:?Set PGHOST to the PostgreSQL endpoint}" \
          "${PGDATABASE:?Set PGDATABASE to the source database}" \
          "${PGUSER:?Set PGUSER to the PostgreSQL role}"
        export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}
        ;;
    *)
        printf '%s\n' 'QWORK_BACKUP_MODE must be compose or direct.' >&2
        exit 2
        ;;
esac

compose_db() {
    if [ -n "${COMPOSE_FILE:-}" ]; then
        docker compose exec -T db "$@"
    else
        docker compose --project-directory "$backend_dir" \
            -f "$backend_dir/compose.yaml" -f "$backend_dir/compose.postgres.yaml" \
            exec -T db "$@"
    fi
}

postgres_command() {
    if [ "$mode" = direct ]; then
        "$@"
    else
        compose_db sh -ec '
            export PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
            exec "$@"
        ' sh "$@"
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
        postgres_command pg_dump -Fc >"$temporary"
        postgres_command pg_restore --list <"$temporary" >/dev/null
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
        postgres_command pg_restore --list <"$archive" >/dev/null
        postgres_command sh -ec 'exec createdb --maintenance-db="$PGDATABASE" -- "$1"' sh "$destination"
        if ! postgres_command pg_restore --single-transaction --no-owner --no-privileges \
            -d "$destination" <"$archive"; then
            postgres_command sh -ec 'exec dropdb --maintenance-db="$PGDATABASE" -- "$1"' sh "$destination"
            exit 1
        fi
        printf 'Restored into database %s\n' "$destination"
        ;;
    *) usage ;;
esac
