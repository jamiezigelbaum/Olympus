#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-${OLYMPUS_REPO_ROOT:-}}"
if [[ -z "$repo_root" ]]; then
  echo "FAIL repository root is not configured." >&2
  echo "Pass it as the first argument or set OLYMPUS_REPO_ROOT to the Olympus checkout path." >&2
  exit 2
fi
xanthos_key="~/.ssh/id_ed25519_xanthos_machine"

private_host="${OLYMPUS_PRIVATE_HOST_SSH_ALIAS:-}"
if [[ -z "$private_host" ]]; then
  echo "FAIL private host SSH alias is not configured." >&2
  echo "Set OLYMPUS_PRIVATE_HOST_SSH_ALIAS to the ssh_config alias of the private host." >&2
  echo "The alias is operator-specific and is deliberately not committed to this repository." >&2
  exit 2
fi

github_key_fingerprint="${OLYMPUS_GITHUB_SSH_KEY_FINGERPRINT:-}"
if [[ -z "$github_key_fingerprint" ]]; then
  echo "FAIL GitHub SSH key fingerprint is not configured." >&2
  echo "Set OLYMPUS_GITHUB_SSH_KEY_FINGERPRINT to the expected agent key fingerprint" >&2
  echo "(for example SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx); read it from" >&2
  echo "'ssh-keygen -lf <your GitHub key>.pub'. The fingerprint is operator-specific and" >&2
  echo "is deliberately not committed to this repository." >&2
  exit 2
fi

run_with_timeout() {
  local timeout_secs="$1"
  shift

  local output_file pid status
  output_file="$(mktemp "${TMPDIR:-/tmp}/olympus-ssh-health.XXXXXX")"
  "$@" >"$output_file" 2>&1 &
  pid="$!"

  for ((elapsed = 0; elapsed < timeout_secs; elapsed += 1)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      set +e
      wait "$pid"
      status="$?"
      set -e
      cat "$output_file"
      rm -f "$output_file"
      return "$status"
    fi
    sleep 1
  done

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  cat "$output_file"
  rm -f "$output_file"
  echo "TIMEOUT after ${timeout_secs}s: $*" >&2
  return 124
}

expect_effective() {
  local host="$1"
  local pattern="$2"

  if ! ssh -G "$host" 2>/dev/null | grep -Fqx "$pattern"; then
    echo "FAIL ssh -G $host missing: $pattern" >&2
    echo "Effective config:" >&2
    ssh -G "$host" 2>/dev/null | grep -E '^(hostname|user|hostkeyalias|identityagent|identityfile|identitiesonly|addkeystoagent|usekeychain|stricthostkeychecking|updatehostkeys|connecttimeout|controlpath) ' >&2
    exit 1
  fi
}

echo "Checking effective SSH config..."
expect_effective github.com "identityagent SSH_AUTH_SOCK"
expect_effective github.com "stricthostkeychecking true"
expect_effective github.com "addkeystoagent false"
expect_effective "$private_host" "hostname $private_host.tail5e5fdd.ts.net"
expect_effective "$private_host" "hostkeyalias $private_host.local"
expect_effective "$private_host" "identityagent none"
expect_effective "$private_host" "identityfile $xanthos_key"
expect_effective "$private_host" "stricthostkeychecking true"
expect_effective delphi "hostname delphi.tail5e5fdd.ts.net"
expect_effective delphi "hostkeyalias delphi.local"
expect_effective delphi "identityagent none"
expect_effective delphi "identityfile $xanthos_key"
expect_effective delphi "stricthostkeychecking true"

echo "Checking active SSH agent key..."
if ! ssh-add -l | grep -Fq "$github_key_fingerprint"; then
  echo "FAIL active SSH agent is missing the owner GitHub key" >&2
  ssh-add -l >&2 || true
  exit 1
fi

echo "Checking GitHub SSH authentication..."
github_output=""
github_ok=0
for attempt in 1 2 3 4 5; do
  if github_output="$(run_with_timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 -o ControlMaster=no -o ControlPath=none -T git@github.com)"; then
    :
  fi
  if grep -Fq "successfully authenticated" <<<"$github_output"; then
    github_ok=1
    break
  fi
  echo "GitHub SSH attempt $attempt failed; retrying..." >&2
  sleep 2
done
if [[ "$github_ok" != "1" ]]; then
  echo "$github_output" >&2
  echo "FAIL GitHub SSH authentication did not succeed" >&2
  exit 1
fi

echo "Checking the private host over Tailscale..."
private_host_output="$(run_with_timeout 20 env SSH_AUTH_SOCK=/tmp/olympus-missing-agent ssh -o BatchMode=yes -o ConnectTimeout=8 "$private_host" 'printf "PRIVATE_HOST_OK %s %s\n" "$(hostname)" "$(whoami)"; command -v codex; codex --version')"
echo "$private_host_output"

echo "Checking Delphi over Tailscale..."
delphi_output="$(run_with_timeout 20 env SSH_AUTH_SOCK=/tmp/olympus-missing-agent ssh -o BatchMode=yes -o ConnectTimeout=8 delphi 'printf "DELPHI_OK %s %s\n" "$(hostname)" "$(whoami)"; command -v codex; codex --version')"
echo "$delphi_output"

echo "Checking Olympus Git remote..."
git_ok=0
for attempt in 1 2 3 4 5; do
  if git_output="$(run_with_timeout 30 git -C "$repo_root" ls-remote --heads origin main)"; then
    echo "$git_output"
    git_ok=1
    break
  fi
  echo "$git_output" >&2
  echo "Git remote attempt $attempt failed; retrying..." >&2
  sleep 2
done
if [[ "$git_ok" != "1" ]]; then
  echo "FAIL Olympus Git remote did not respond" >&2
  exit 1
fi

echo "Checking Olympus Git push dry-run..."
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=8 -o ControlMaster=no -o ControlPath=none'
if ! push_output="$(run_with_timeout 30 git -C "$repo_root" push --dry-run origin HEAD:main)"; then
  echo "$push_output" >&2
  echo "FAIL Olympus Git push dry-run did not succeed" >&2
  exit 1
fi
unset GIT_SSH_COMMAND
echo "$push_output"

echo "SSH connectivity health check passed."
