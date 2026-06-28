#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.wallet.yml"
BASE_ENV_FILE="$SCRIPT_DIR/env.production.example"
MOCK_ENV_FILE="$SCRIPT_DIR/env.local.mock.example"

load_env_file() {
  env_file=$1
  if [ ! -f "$env_file" ]; then
    echo "env file not found: $env_file" >&2
    exit 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*)
        continue
        ;;
      *=*)
        key=${line%%=*}
        value=${line#*=}
        export "$key=$value"
        ;;
    esac
  done < "$env_file"
}

print_usage() {
  cat <<'EOF'
Usage: run_local_mock_stack.sh [up|down|config|logs|ps|smoke] [docker-compose args...]

Loads env.production.example plus env.local.mock.example, then runs
docker-compose against docker-compose.wallet.yml.

Examples:
  ./run_local_mock_stack.sh config
  ./run_local_mock_stack.sh up -d
  ./run_local_mock_stack.sh smoke
  ./run_local_mock_stack.sh logs wallet-api sms-bridge
EOF
}

run_smoke() {
  if command -v python3 >/dev/null 2>&1; then
    exec python3 "$SCRIPT_DIR/smoke_local_mock_stack.py" "$@"
  fi
  if command -v python >/dev/null 2>&1; then
    exec python "$SCRIPT_DIR/smoke_local_mock_stack.py" "$@"
  fi
  echo "python3 or python is required to run the smoke test" >&2
  exit 1
}

run_compose() {
  if docker compose version >/dev/null 2>&1; then
    exec docker compose -f "$COMPOSE_FILE" "$@"
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    exec docker-compose -f "$COMPOSE_FILE" "$@"
  fi
  echo "docker compose or docker-compose is required" >&2
  exit 1
}

command=${1:-up}
if [ $# -gt 0 ]; then
  shift
fi

load_env_file "$BASE_ENV_FILE"
load_env_file "$MOCK_ENV_FILE"

case "$command" in
  up)
    run_compose up "$@"
    ;;
  down)
    run_compose down "$@"
    ;;
  config)
    run_compose config "$@"
    ;;
  logs)
    run_compose logs "$@"
    ;;
  ps)
    run_compose ps "$@"
    ;;
  smoke)
    run_smoke "$@"
    ;;
  help|-h|--help)
    print_usage
    ;;
  *)
    echo "unsupported command: $command" >&2
    print_usage >&2
    exit 2
    ;;
esac