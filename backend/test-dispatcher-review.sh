#!/bin/sh
set -eu

backend_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dependency_jar=${QWORK_TEST_JAR:-"$backend_dir/target/qwork-api.jar"}
if [ ! -f "$dependency_jar" ]; then
    echo "Build the backend first, or set QWORK_TEST_JAR to an existing qwork API jar." >&2
    exit 1
fi

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/qwork-dispatcher-review.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
unset QWORK_DATABASE_URL
export QWORK_DB="$test_dir/review.sqlite3"
mkdir "$test_dir/classes"

# Compile changed application classes first so a pre-existing jar cannot mask stale source.
javac --release 21 -encoding UTF-8 -cp "$dependency_jar" -d "$test_dir/classes" \
    "$backend_dir"/src/main/java/qwork/*.java \
    "$backend_dir/tests/qwork/DispatcherReviewCheck.java"
java -ea -Djava.awt.headless=true -cp "$test_dir/classes:$dependency_jar" qwork.DispatcherReviewCheck
