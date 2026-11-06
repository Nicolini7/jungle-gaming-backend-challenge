#!/bin/bash
set -euo pipefail

# Runs only against the Docker context already selected by the caller. No publishing or jobs.
# Modes: all (default), checks, demo, shutdown. Set SKIP_BUILD=1 for an existing image.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mode=${1:-all}
case "$mode" in all|checks|demo|shutdown) ;; *) echo 'Usage: validate-containers.sh [all|checks|demo|shutdown]' >&2; exit 2 ;; esac
project=${COMPOSE_PROJECT_NAME:-jungle-challenge-validation}
compose=(docker compose -p "$project" -f compose.yaml -f compose.test.yaml -f compose.validation.yaml)
artifacts="$PWD/.artifacts/containers"
mkdir -p "$artifacts"
"${compose[@]}" config --quiet

if [[ "$mode" == all || "$mode" == checks ]]; then
  # Publishers use the global outbox; tests need the three demo APIs stopped.
  "${compose[@]}" stop --timeout 35 api1 api2 api3
  if [[ "${SKIP_BUILD:-0}" != 1 ]]; then "${compose[@]}" build test localstack; fi
  "${compose[@]}" run --rm --no-deps test bun run typecheck 2>&1 | tee "$artifacts/typecheck.log"
  "${compose[@]}" run --rm --no-deps test bun run test:unit 2>&1 | tee "$artifacts/unit.log"
  "${compose[@]}" run --rm test 2>&1 | tee "$artifacts/integration.log"
fi

if [[ "$mode" == all || "$mode" == demo ]]; then
  "${compose[@]}" up -d --wait --wait-timeout 180 api1 api2 api3
  demo_container="$project-demo-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
  "${compose[@]}" run --no-deps --name "$demo_container" \
    -e DEMO_URLS=http://api1:3000,http://api2:3000,http://api3:3000 \
    test bun run demo:http 2>&1 | tee "$artifacts/demo-http.log"
  docker cp "$demo_container:/app/.artifacts/demo-http.json" "$artifacts/demo-http.json"
  docker rm "$demo_container" >/dev/null
fi

if [[ "$mode" == all || "$mode" == shutdown ]]; then
  "${compose[@]}" up -d --wait --wait-timeout 180 api1 api2 api3
  container=$("${compose[@]}" ps -q api1)
  [[ -n "$container" ]] || { echo 'api1 container not found' >&2; exit 1; }
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  started=$(date +%s)
  # Docker sends an actual SIGTERM, then SIGKILL only if the 35-second grace is exceeded.
  "${compose[@]}" stop --timeout 35 api1
  elapsed=$(( $(date +%s) - started ))
  docker inspect "$container" >"$artifacts/sigterm-inspect.json"
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
  oom=$(docker inspect --format '{{.State.OOMKilled}}' "$container")
  [[ "$exit_code" == 0 && "$oom" == false ]] || { echo "Shutdown failed: exit=$exit_code OOM=$oom" >&2; exit 1; }
  "${compose[@]}" logs --no-color --since "$since" api1 >"$artifacts/sigterm.log"
  grep -F '"event":"shutdown_started"' "$artifacts/sigterm.log" | grep -F '"signal":"SIGTERM"' >/dev/null
  printf '{"signal":"SIGTERM","graceSeconds":35,"elapsedSeconds":%s,"exitCode":%s,"oomKilled":%s}\n' "$elapsed" "$exit_code" "$oom" >"$artifacts/sigterm-result.json"
  "${compose[@]}" up -d --wait --wait-timeout 180 api1

  if [[ -f "$artifacts/demo-http.json" ]]; then
    "${compose[@]}" run --rm --no-deps \
      -v "$artifacts/demo-http.json:/tmp/jungle-validation-demo.json:ro" \
      test bun run scripts/reconcile-demo.ts /tmp/jungle-validation-demo.json \
      >"$artifacts/reconciliation-after-restart.json"
    "${compose[@]}" run --rm --no-deps \
      -v "$artifacts/demo-http.json:/tmp/jungle-validation-demo.json:ro" \
      test bun run scripts/verify-event-demo.ts /tmp/jungle-validation-demo.json \
      >"$artifacts/event-read-models-after-restart.json"
  else
    echo 'Shutdown verified; run demo mode first to also compare balances after restart.'
  fi
fi

"${compose[@]}" ps --all --format json >"$artifacts/compose-ps.json"
echo "Container evidence: $artifacts"
