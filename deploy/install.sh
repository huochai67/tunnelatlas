#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${TUNNELATLAS_REPOSITORY:-huochai67/tunnelatlas}"
VERSION="${TUNNELATLAS_VERSION:-latest}"
SERVER_URL="${TUNNELATLAS_SERVER_URL:-}"
SITE_ID="${TUNNELATLAS_SITE_ID:-}"
AGENT_NAME="${TUNNELATLAS_AGENT_NAME:-$(hostname -s 2>/dev/null || hostname)}"
ENROLLMENT_TOKEN="${TUNNELATLAS_ENROLLMENT_TOKEN:-}"
unset TUNNELATLAS_ENROLLMENT_TOKEN
SING_BOX_BINARY="${TUNNELATLAS_SING_BOX_BINARY:-}"
SING_BOX_CONFIG="${TUNNELATLAS_SING_BOX_CONFIG:-/etc/sing-box/config.json}"

CONFIG_DIR="/etc/tunnelatlas"
STATE_DIR="/var/lib/tunnelatlas"
CONFIG_PATH="$CONFIG_DIR/config.yaml"
IDENTITY_PATH="$STATE_DIR/identity.json"
BIN_PATH="/usr/local/bin/tunnelatlasd"
SYSTEMD_SERVICE_PATH="/etc/systemd/system/tunnelatlas.service"
OPENRC_SERVICE_PATH="/etc/init.d/tunnelatlas"
TMP_DIR=""
CONFIG_TEMP=""
SCRUB_ENROLLMENT=0

usage() {
  cat <<'EOF'
Install or upgrade tunnelatlasd on a Linux system using systemd or OpenRC.

Usage:
  sudo ./install.sh [options]

First-install options:
  --server-url URL         TunnelAtlas Worker URL (required)
  --site-id ID             Existing site ID (required)
  --agent-name NAME        Node display name (default: hostname)
  --sing-box-config PATH   Source sing-box config (default: /etc/sing-box/config.json)
  --sing-box-binary PATH   sing-box binary (default: auto-detect)

Download options:
  --version VERSION        Release version, with or without v (default: latest)
  --repository OWNER/REPO  GitHub repository
  -h, --help               Show this help

The enrollment token is read silently from /dev/tty. For unattended installs,
provide it through TUNNELATLAS_ENROLLMENT_TOKEN instead of a command-line flag.
An existing installation keeps its config and identity and does not need a token.
EOF
}

log() {
  printf '[tunnelatlas] %s\n' "$*"
}

die() {
  printf '[tunnelatlas] error: %s\n' "$*" >&2
  exit 1
}

install_openrc_service() {
  if [[ -f "$PACKAGE_DIR/tunnelatlas.initd" ]]; then
    install -m 755 "$PACKAGE_DIR/tunnelatlas.initd" "$OPENRC_SERVICE_PATH"
    return
  fi

  log "release does not include the OpenRC service; installing the built-in definition"
  cat >"$OPENRC_SERVICE_PATH" <<'EOF'
#!/sbin/openrc-run

name="TunnelAtlas reporting daemon"
description="Supervises sing-box and reports tunnel state to TunnelAtlas"
supervisor="supervise-daemon"
command="/usr/local/bin/tunnelatlasd"
command_args="run"
directory="/var/lib/tunnelatlas"
respawn_delay=5
respawn_max=0
required_dirs="/var/lib/tunnelatlas"
required_files="/etc/tunnelatlas/config.yaml /var/lib/tunnelatlas/identity.json"

depend() {
  after net firewall
  use logger dns
}
EOF
  chmod 755 "$OPENRC_SERVICE_PATH"
}

cleanup() {
  if [[ "$SCRUB_ENROLLMENT" == 1 && -f "$CONFIG_PATH" ]]; then
    sed -i '/^enrollmentToken:/d' "$CONFIG_PATH"
  fi
  [[ -z "$CONFIG_TEMP" ]] || rm -f "$CONFIG_TEMP"
  [[ -z "$TMP_DIR" ]] || rm -rf "$TMP_DIR"
  ENROLLMENT_TOKEN=""
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) [[ $# -ge 2 ]] || die "$1 requires a value"; SERVER_URL="$2"; shift 2 ;;
    --site-id) [[ $# -ge 2 ]] || die "$1 requires a value"; SITE_ID="$2"; shift 2 ;;
    --agent-name) [[ $# -ge 2 ]] || die "$1 requires a value"; AGENT_NAME="$2"; shift 2 ;;
    --sing-box-config) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_CONFIG="$2"; shift 2 ;;
    --sing-box-binary) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_BINARY="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die "$1 requires a value"; VERSION="$2"; shift 2 ;;
    --repository) [[ $# -ge 2 ]] || die "$1 requires a value"; REPOSITORY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run this script as root"
for command in awk chmod curl grep hostname install mktemp mv rm sed sha256sum tar uname; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid GitHub repository: $REPOSITORY"

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  INIT_SYSTEM="openrc"
  command -v supervise-daemon >/dev/null 2>&1 || die "OpenRC supervise-daemon is required"
  [[ -x /sbin/openrc-run ]] || die "OpenRC interpreter not found at /sbin/openrc-run"
else
  die "neither a running systemd nor OpenRC installation was detected"
fi
log "detected init system: $INIT_SYSTEM"

case "$(uname -m)" in
  x86_64|amd64) ARCHITECTURE="x86_64" ;;
  aarch64|arm64) ARCHITECTURE="aarch64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
if [[ -e "/lib/ld-musl-${ARCHITECTURE}.so.1" ]] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
  LIBC="musl"
else
  LIBC="gnu"
fi
PLATFORM="${ARCHITECTURE}-linux-${LIBC}"
log "detected platform: $PLATFORM"

if [[ "$VERSION" == latest ]]; then
  log "resolving latest release"
  RELEASE_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest")"
  TAG="${RELEASE_URL##*/}"
else
  TAG="$VERSION"
  [[ "$TAG" == v* ]] || TAG="v$TAG"
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid release version: $TAG"
VERSION_NUMBER="${TAG#v}"
ARCHIVE="tunnelatlasd-${VERSION_NUMBER}-${PLATFORM}.tar.gz"
BASE_URL="https://github.com/$REPOSITORY/releases/download/$TAG"

TMP_DIR="$(mktemp -d)"
log "downloading $ARCHIVE"
curl -fL --retry 3 --retry-delay 2 -o "$TMP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE" || die "release asset is unavailable: $ARCHIVE"
curl -fL --retry 3 --retry-delay 2 -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS" || die "release checksums are unavailable"

EXPECTED_SUM="$(awk -v archive="$ARCHIVE" '$2 == archive || $2 == "./" archive { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
[[ "$EXPECTED_SUM" =~ ^[0-9a-fA-F]{64}$ ]] || die "$ARCHIVE is missing or invalid in SHA256SUMS"
printf '%s  %s\n' "$EXPECTED_SUM" "$TMP_DIR/$ARCHIVE" | sha256sum -c -s - || die "release checksum verification failed"

tar -C "$TMP_DIR" --no-same-owner -xzf "$TMP_DIR/$ARCHIVE"
PACKAGE_DIR="$TMP_DIR/tunnelatlasd-${VERSION_NUMBER}-${PLATFORM}"
[[ -x "$PACKAGE_DIR/tunnelatlasd" ]] || die "release archive does not contain tunnelatlasd"
if [[ "$INIT_SYSTEM" == systemd ]]; then
  [[ -f "$PACKAGE_DIR/tunnelatlas.service" ]] || die "release archive does not contain tunnelatlas.service"
fi

install -m 755 "$PACKAGE_DIR/tunnelatlasd" "$BIN_PATH"
if [[ "$INIT_SYSTEM" == systemd ]]; then
  install -m 644 "$PACKAGE_DIR/tunnelatlas.service" "$SYSTEMD_SERVICE_PATH"
else
  install_openrc_service
fi
install -d -m 755 "$CONFIG_DIR" "$STATE_DIR"
log "installed $($BIN_PATH --version)"

if [[ -f "$CONFIG_PATH" ]]; then
  [[ -f "$IDENTITY_PATH" ]] || die "$CONFIG_PATH exists but $IDENTITY_PATH is missing; restore the identity or remove the config to enroll again"
  sed -i '/^enrollmentToken:/d' "$CONFIG_PATH"
  log "keeping existing configuration and identity"
else
  [[ ! -e "$IDENTITY_PATH" ]] || die "$IDENTITY_PATH exists but $CONFIG_PATH is missing; restore the config instead of enrolling a second identity"
  [[ -n "$SERVER_URL" ]] || die "--server-url is required for the first installation"
  [[ -n "$SITE_ID" ]] || die "--site-id is required for the first installation"
  [[ "$SITE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || die "invalid site ID"
  [[ -n "$AGENT_NAME" ]] || die "agent name cannot be empty"
  for value in "$SERVER_URL" "$SITE_ID" "$AGENT_NAME" "$SING_BOX_CONFIG"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "configuration values must fit on one line"
  done
  [[ -f "$SING_BOX_CONFIG" ]] || die "sing-box source config not found: $SING_BOX_CONFIG"
  if [[ -z "$SING_BOX_BINARY" ]]; then
    SING_BOX_BINARY="$(command -v sing-box || true)"
  fi
  [[ -n "$SING_BOX_BINARY" && -x "$SING_BOX_BINARY" ]] || die "sing-box binary not found; install it or pass --sing-box-binary"

  if [[ -z "$ENROLLMENT_TOKEN" ]]; then
    [[ -r /dev/tty ]] || die "no terminal is available; set TUNNELATLAS_ENROLLMENT_TOKEN"
    printf 'One-time enrollment token: ' >/dev/tty
    IFS= read -r -s ENROLLMENT_TOKEN </dev/tty || die "failed to read enrollment token"
    printf '\n' >/dev/tty
  fi
  [[ -n "$ENROLLMENT_TOKEN" ]] || die "enrollment token cannot be empty"
  [[ "$ENROLLMENT_TOKEN" != *$'\n'* && "$ENROLLMENT_TOKEN" != *$'\r'* ]] || die "enrollment token must fit on one line"

  yaml_quote() {
    local escaped
    escaped="$(printf '%s' "$1" | sed "s/'/''/g")"
    printf "'%s'" "$escaped"
  }

  umask 077
  SCRUB_ENROLLMENT=1
  CONFIG_TEMP="$(mktemp "$CONFIG_DIR/.config.yaml.XXXXXX")"
  cat >"$CONFIG_TEMP" <<EOF
serverUrl: $(yaml_quote "$SERVER_URL")
agentName: $(yaml_quote "$AGENT_NAME")
siteId: $(yaml_quote "$SITE_ID")
enrollmentToken: $(yaml_quote "$ENROLLMENT_TOKEN")
reportIntervalSeconds: 60
labels: {}
singBox:
  binaryPath: $(yaml_quote "$SING_BOX_BINARY")
  sourceConfigPath: $(yaml_quote "$SING_BOX_CONFIG")
  managedConfigPath: '$STATE_DIR/sing-box.json'
  workingDirectory: '$STATE_DIR'
  reconcileIntervalSeconds: 5
  restartDelaySeconds: 5
  shutdownTimeoutSeconds: 10
EOF
  chmod 600 "$CONFIG_TEMP"
  mv -f "$CONFIG_TEMP" "$CONFIG_PATH"
  CONFIG_TEMP=""

  "$BIN_PATH" check
  "$BIN_PATH" enroll
  sed -i '/^enrollmentToken:/d' "$CONFIG_PATH"
  SCRUB_ENROLLMENT=0
  ENROLLMENT_TOKEN=""
  log "node enrollment completed"
fi

"$BIN_PATH" check
if [[ "$INIT_SYSTEM" == systemd ]]; then
  systemctl daemon-reload
  if systemctl list-unit-files sing-box.service --no-legend 2>/dev/null | grep -q '^sing-box\.service'; then
    if systemctl is-active --quiet sing-box.service || systemctl is-enabled --quiet sing-box.service 2>/dev/null; then
      log "disabling sing-box.service because tunnelatlasd will supervise sing-box"
      systemctl disable --now sing-box.service
    fi
  fi
  systemctl enable tunnelatlas.service
  systemctl restart tunnelatlas.service
  LOG_COMMAND="journalctl -u tunnelatlas.service -f"
else
  if [[ -x /etc/init.d/sing-box ]]; then
    if rc-service sing-box status >/dev/null 2>&1; then
      log "stopping sing-box because tunnelatlasd will supervise it"
      rc-service sing-box stop
    fi
    rc-update del sing-box default >/dev/null 2>&1 || true
  fi
  rc-update add tunnelatlas default
  if rc-service tunnelatlas status >/dev/null 2>&1; then
    rc-service tunnelatlas restart
  else
    rc-service tunnelatlas zap >/dev/null 2>&1 || true
    rc-service tunnelatlas start
  fi
  LOG_COMMAND="rc-service tunnelatlas status"
fi
log "deployment complete; inspect service with: $LOG_COMMAND"
