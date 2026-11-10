#!/bin/sh
set -eu

backend_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dependency_jar=${QWORK_TEST_JAR:-"$backend_dir/target/qwork-api.jar"}
if [ ! -f "$dependency_jar" ]; then
    echo "Build the backend first, or set QWORK_TEST_JAR to an existing qwork API jar." >&2
    exit 1
fi

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/qwork-telegram-reports.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
mkdir "$test_dir/classes"

javac --release 21 -encoding UTF-8 -cp "$dependency_jar" -d "$test_dir/classes" \
    "$backend_dir/src/main/java/qwork/Db.java" \
    "$backend_dir"/src/main/java/qwork/TelegramReport*.java \
    "$backend_dir/tests/qwork/TelegramReportsCheck.java" \
    "$backend_dir/tests/qwork/TelegramReportPostgresCheck.java"
java -ea -Djava.awt.headless=true -cp "$test_dir/classes:$dependency_jar" qwork.TelegramReportsCheck "$test_dir"
if [ -n "${QWORK_TEST_TELEGRAM_POSTGRES_URL:-}" ]; then
    java -ea -Djava.awt.headless=true -cp "$test_dir/classes:$dependency_jar" qwork.TelegramReportPostgresCheck "$test_dir"
fi
