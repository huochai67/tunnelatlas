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
SING_BOX_INSTALL_MODE="${TUNNELATLAS_SING_BOX_INSTALL_MODE:-auto}"
SING_BOX_PROTOCOLS="${TUNNELATLAS_SING_BOX_PROTOCOLS:-ss}"
SING_BOX_HOST=""
SING_BOX_REALITY_SNI=""
SING_BOX_SS_METHOD=""
SING_BOX_SS_PORT=""
SING_BOX_HY2_PORT=""
SING_BOX_TUIC_PORT=""
SING_BOX_REALITY_PORT=""
SING_BOX_ANYTLS_PORT=""
SING_BOX_VMESS_PORT=""
SING_BOX_VMESS_PATH=""
SING_BOX_VMESS_HOST=""

SING_BOX_DEPLOY_REF="60d479ede494edce840fdab7569a18a20c6fc2ba"
SING_BOX_DEPLOY_SHA256="06f451545e4c98f0d9171fd812482faecc8a5213a4f58a58ea081f80a6e26ac8"

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

sing-box deployment options:
  --install-sing-box       Deploy/reinstall sing-box during first TunnelAtlas installation
  --skip-sing-box-install  Never install sing-box; require an existing binary and config
  --sing-box-protocols LIST
                           Protocols: ss,hy2,tuic,reality,anytls,vmess,all (default: ss)
  --sing-box-host HOST     Public IP or DDNS name used in generated client links
  --sing-box-reality-sni SNI
  --sing-box-ss-method METHOD
  --sing-box-ss-port PORT
  --sing-box-hy2-port PORT
  --sing-box-tuic-port PORT
  --sing-box-reality-port PORT
  --sing-box-anytls-port PORT
  --sing-box-vmess-port PORT
  --sing-box-vmess-path PATH
  --sing-box-vmess-host HOST

Download options:
  --version VERSION        Release version, with or without v (default: latest)
  --repository OWNER/REPO  GitHub repository
  -h, --help               Show this help

The enrollment token is read silently from /dev/tty. For unattended installs,
provide it through TUNNELATLAS_ENROLLMENT_TOKEN instead of a command-line flag.
An existing installation keeps its config and identity and does not need a token.
If sing-box or its config is missing, the default behavior deploys a random-port
Shadowsocks server using the pinned huochai67/singbox-deploy installer.
EOF
}

log() {
  printf '[tunnelatlas] %s\n' "$*"
}

die() {
  printf '[tunnelatlas] error: %s\n' "$*" >&2
  exit 1
}

deploy_sing_box() {
  local helper="$TMP_DIR/install-singbox-yyds.sh"
  local helper_url="https://raw.githubusercontent.com/huochai67/singbox-deploy/$SING_BOX_DEPLOY_REF/install-singbox-yyds.sh"
  local -a helper_args=(--non-interactive --protocols "$SING_BOX_PROTOCOLS" --node-name "$AGENT_NAME")

  log "downloading the pinned sing-box deployment helper"
  curl -fL --retry 3 --retry-delay 2 -o "$helper" "$helper_url" || die "failed to download the sing-box deployment helper"
  printf '%s  %s\n' "$SING_BOX_DEPLOY_SHA256" "$helper" | sha256sum -c -s - || die "sing-box deployment helper checksum verification failed"
  sed -i 's#http://dl-cdn.alpinelinux.org/#https://dl-cdn.alpinelinux.org/#g' "$helper"
  bash -n "$helper" || die "sing-box deployment helper syntax check failed"

  [[ "$SING_BOX_INSTALL_MODE" == always ]] && helper_args+=(--reinstall)
  [[ -z "$SING_BOX_HOST" ]] || helper_args+=(--host "$SING_BOX_HOST")
  [[ -z "$SING_BOX_REALITY_SNI" ]] || helper_args+=(--reality-sni "$SING_BOX_REALITY_SNI")
  [[ -z "$SING_BOX_SS_METHOD" ]] || helper_args+=(--ss-method "$SING_BOX_SS_METHOD")
  [[ -z "$SING_BOX_SS_PORT" ]] || helper_args+=(--ss-port "$SING_BOX_SS_PORT")
  [[ -z "$SING_BOX_HY2_PORT" ]] || helper_args+=(--hy2-port "$SING_BOX_HY2_PORT")
  [[ -z "$SING_BOX_TUIC_PORT" ]] || helper_args+=(--tuic-port "$SING_BOX_TUIC_PORT")
  [[ -z "$SING_BOX_REALITY_PORT" ]] || helper_args+=(--reality-port "$SING_BOX_REALITY_PORT")
  [[ -z "$SING_BOX_ANYTLS_PORT" ]] || helper_args+=(--anytls-port "$SING_BOX_ANYTLS_PORT")
  [[ -z "$SING_BOX_VMESS_PORT" ]] || helper_args+=(--vmess-port "$SING_BOX_VMESS_PORT")
  [[ -z "$SING_BOX_VMESS_PATH" ]] || helper_args+=(--vmess-path "$SING_BOX_VMESS_PATH")
  [[ -z "$SING_BOX_VMESS_HOST" ]] || helper_args+=(--vmess-host "$SING_BOX_VMESS_HOST")

  bash "$helper" "${helper_args[@]}"
  log "sing-box deployment helper completed"
}

install_sing_box_binary() {
  local official_installer="$TMP_DIR/install-sing-box-official.sh"

  if command -v apk >/dev/null 2>&1; then
    log "installing sing-box from the Alpine Edge community repository"
    apk update
    apk add --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community sing-box
  else
    log "installing sing-box with the official SagerNet installer"
    curl -fL --retry 3 --retry-delay 2 -o "$official_installer" https://sing-box.app/install.sh || die "failed to download the official sing-box installer"
    bash -n "$official_installer" || die "official sing-box installer syntax check failed"
    bash "$official_installer"
  fi
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
    --install-sing-box) SING_BOX_INSTALL_MODE="always"; shift ;;
    --skip-sing-box-install) SING_BOX_INSTALL_MODE="never"; shift ;;
    --sing-box-protocols) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_PROTOCOLS="$2"; shift 2 ;;
    --sing-box-host) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_HOST="$2"; shift 2 ;;
    --sing-box-reality-sni) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_REALITY_SNI="$2"; shift 2 ;;
    --sing-box-ss-method) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_SS_METHOD="$2"; shift 2 ;;
    --sing-box-ss-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_SS_PORT="$2"; shift 2 ;;
    --sing-box-hy2-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_HY2_PORT="$2"; shift 2 ;;
    --sing-box-tuic-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_TUIC_PORT="$2"; shift 2 ;;
    --sing-box-reality-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_REALITY_PORT="$2"; shift 2 ;;
    --sing-box-anytls-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_ANYTLS_PORT="$2"; shift 2 ;;
    --sing-box-vmess-port) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_VMESS_PORT="$2"; shift 2 ;;
    --sing-box-vmess-path) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_VMESS_PATH="$2"; shift 2 ;;
    --sing-box-vmess-host) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_VMESS_HOST="$2"; shift 2 ;;
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
[[ "$SING_BOX_INSTALL_MODE" =~ ^(auto|always|never)$ ]] || die "invalid TUNNELATLAS_SING_BOX_INSTALL_MODE"

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
  [[ "$SING_BOX_INSTALL_MODE" != always ]] || die "--install-sing-box is only supported during the first TunnelAtlas installation"
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
  if [[ -z "$SING_BOX_BINARY" ]]; then
    SING_BOX_BINARY="$(command -v sing-box || true)"
  fi

  if [[ "$SING_BOX_INSTALL_MODE" == always ]]; then
    if [[ -f "$SING_BOX_CONFIG" ]]; then
      install -m 600 "$SING_BOX_CONFIG" "$SING_BOX_CONFIG.pre-tunnelatlas"
      log "backed up the existing sing-box config to $SING_BOX_CONFIG.pre-tunnelatlas"
    fi
    deploy_sing_box
    SING_BOX_BINARY="$(command -v sing-box || true)"
  elif [[ "$SING_BOX_INSTALL_MODE" == auto && ! -f "$SING_BOX_CONFIG" ]]; then
    [[ "$SING_BOX_CONFIG" == /etc/sing-box/config.json ]] || die "automatic sing-box config generation only supports /etc/sing-box/config.json"
    deploy_sing_box
    SING_BOX_BINARY="$(command -v sing-box || true)"
  elif [[ "$SING_BOX_INSTALL_MODE" == auto && ( -z "$SING_BOX_BINARY" || ! -x "$SING_BOX_BINARY" ) ]]; then
    install_sing_box_binary
    SING_BOX_BINARY="$(command -v sing-box || true)"
  fi

  [[ -f "$SING_BOX_CONFIG" ]] || die "sing-box source config not found: $SING_BOX_CONFIG"
  [[ -n "$SING_BOX_BINARY" && -x "$SING_BOX_BINARY" ]] || die "sing-box binary not found; install it or pass --sing-box-binary"
  chmod 600 "$SING_BOX_CONFIG"

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
