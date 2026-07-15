#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${TUNNELATLAS_REPOSITORY:-huochai67/tunnelatlas}"
VERSION="${TUNNELATLAS_VERSION:-latest}"
SERVER_URL="${TUNNELATLAS_SERVER_URL:-}"
ENROLLMENT_TOKEN="${TUNNELATLAS_ENROLLMENT_TOKEN:-}"
unset TUNNELATLAS_ENROLLMENT_TOKEN
SING_BOX_BINARY="${TUNNELATLAS_SING_BOX_BINARY:-}"
SING_BOX_INSTALL_MODE="${TUNNELATLAS_SING_BOX_INSTALL_MODE:-auto}"
SING_BOX_PROTOCOLS="${TUNNELATLAS_SING_BOX_PROTOCOLS:-ss}"
SING_BOX_HOST="${TUNNELATLAS_SING_BOX_HOST:-}"
SING_BOX_REALITY_SNI="${TUNNELATLAS_SING_BOX_REALITY_SNI:-}"
SING_BOX_SS_METHOD="${TUNNELATLAS_SING_BOX_SS_METHOD:-}"
SING_BOX_SS_PORT="${TUNNELATLAS_SING_BOX_SS_PORT:-}"
SING_BOX_HY2_PORT="${TUNNELATLAS_SING_BOX_HY2_PORT:-}"
SING_BOX_TUIC_PORT="${TUNNELATLAS_SING_BOX_TUIC_PORT:-}"
SING_BOX_REALITY_PORT="${TUNNELATLAS_SING_BOX_REALITY_PORT:-}"
SING_BOX_ANYTLS_PORT="${TUNNELATLAS_SING_BOX_ANYTLS_PORT:-}"
SING_BOX_VMESS_PORT="${TUNNELATLAS_SING_BOX_VMESS_PORT:-}"
SING_BOX_VMESS_PATH="${TUNNELATLAS_SING_BOX_VMESS_PATH:-}"
SING_BOX_VMESS_HOST="${TUNNELATLAS_SING_BOX_VMESS_HOST:-}"
INSTALL_MODE="interactive"
MODE_OPTION=""
SING_BOX_MODE_OPTION=""

CONFIG_DIR="/etc/tunnelatlas"
STATE_DIR="/var/lib/tunnelatlas"
CONFIG_PATH="$CONFIG_DIR/config.yaml"
IDENTITY_PATH="$STATE_DIR/identity.json"
BIN_PATH="/usr/local/bin/tunnelatlasd"
SYSTEMD_SERVICE_PATH="/etc/systemd/system/tunnelatlas.service"
OPENRC_SERVICE_PATH="/etc/init.d/tunnelatlas"
TMP_DIR=""
SCRUB_ENROLLMENT=0

usage() {
  cat <<'EOF'
Install TunnelAtlas on a clean Linux system using systemd or OpenRC.

Usage:
  sudo ./install.sh
  sudo ./install.sh --interactive [options]
  sudo TUNNELATLAS_ENROLLMENT_TOKEN=... ./install.sh --non-interactive [options]

Mode options:
  --interactive             Run the installation wizard (default)
  -y, --non-interactive     Never prompt; fail when required values are missing

Required in non-interactive mode:
  --server-url URL

Node options:
  --sing-box-binary PATH
  --install-sing-box
  --skip-sing-box-install
  --sing-box-protocols LIST   ss,hy2,tuic,reality,anytls,vmess,all
  --sing-box-host HOST
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
  --version VERSION
  --repository OWNER/REPO
  -h, --help

This installer never imports an existing sing-box or TunnelAtlas configuration.
Interactive mode reads the enrollment token silently from /dev/tty.
Non-interactive mode requires TUNNELATLAS_ENROLLMENT_TOKEN.
EOF
}

log() { printf '[tunnelatlas] %s\n' "$*"; }
die() { printf '[tunnelatlas] error: %s\n' "$*" >&2; exit 1; }

prompt_value() {
  local variable="$1" label="$2" default_value="$3" required="$4" value="" prompt_text
  local current_value="${!variable}"
  [[ -n "$current_value" ]] && default_value="$current_value"
  while true; do
    if [[ -n "$default_value" ]]; then prompt_text="$label [$default_value]: "; else prompt_text="$label: "; fi
    printf '%s' "$prompt_text" >/dev/tty
    IFS= read -r value </dev/tty || die "failed to read interactive input"
    [[ -n "$value" ]] || value="$default_value"
    if [[ -n "$value" || "$required" != true ]]; then printf -v "$variable" '%s' "$value"; return; fi
    printf '[tunnelatlas] 该项不能为空。\n' >/dev/tty
  done
}

protocol_selected() {
  [[ "$SING_BOX_PROTOCOLS" == all || ",$SING_BOX_PROTOCOLS," == *",$1,"* ]]
}

validate_protocol_list() {
  local protocols_to_validate="$SING_BOX_PROTOCOLS"
  local -a requested_protocols
  local -A seen_protocols=()
  [[ "$protocols_to_validate" != all ]] || protocols_to_validate="ss,hy2,tuic,reality,anytls,vmess"
  IFS=',' read -r -a requested_protocols <<<"$protocols_to_validate"
  [[ ${#requested_protocols[@]} -gt 0 ]] || return 1
  for protocol in "${requested_protocols[@]}"; do
    case "$protocol" in ss|hy2|tuic|reality|anytls|vmess) ;; *) return 1 ;; esac
    [[ -z "${seen_protocols[$protocol]+value}" ]] || return 1
    seen_protocols[$protocol]=1
  done
}

interactive_wizard() {
  [[ -r /dev/tty && -w /dev/tty ]] || die "interactive mode requires /dev/tty; use --non-interactive for automation"
  printf '\nTunnelAtlas 交互式安装\n直接回车可接受方括号中的默认值。\n\n' >/dev/tty
  prompt_value SERVER_URL "Worker URL" "$SERVER_URL" true
  while true; do
    prompt_value SING_BOX_PROTOCOLS "协议列表 (ss,hy2,tuic,reality,anytls,vmess,all)" "$SING_BOX_PROTOCOLS" true
    SING_BOX_PROTOCOLS="${SING_BOX_PROTOCOLS// /}"
    if validate_protocol_list; then break; fi
    printf '[tunnelatlas] 协议列表无效或包含重复项。\n' >/dev/tty
  done
  prompt_value SING_BOX_HOST "公网 IP 或域名（可留空，首次上报后自动识别）" "$SING_BOX_HOST" false

  local install_choice="" install_default="1"
  case "$SING_BOX_INSTALL_MODE" in always) install_default="2" ;; never) install_default="3" ;; esac
  while true; do
    printf 'sing-box 安装方式 [1=自动, 2=强制安装, 3=使用现有二进制] (默认 %s): ' "$install_default" >/dev/tty
    IFS= read -r install_choice </dev/tty || die "failed to read interactive input"
    [[ -n "$install_choice" ]] || install_choice="$install_default"
    case "$install_choice" in
      1|auto) SING_BOX_INSTALL_MODE="auto"; break ;;
      2|always) SING_BOX_INSTALL_MODE="always"; break ;;
      3|never) SING_BOX_INSTALL_MODE="never"; break ;;
      *) printf '[tunnelatlas] 请输入 1、2 或 3。\n' >/dev/tty ;;
    esac
  done
  if [[ "$SING_BOX_INSTALL_MODE" == never ]]; then
    prompt_value SING_BOX_BINARY "sing-box 二进制路径（留空则从 PATH 查找）" "$SING_BOX_BINARY" false
  fi

  if protocol_selected ss; then
    prompt_value SING_BOX_SS_METHOD "Shadowsocks 加密方式" "${SING_BOX_SS_METHOD:-2022-blake3-aes-128-gcm}" true
    prompt_value SING_BOX_SS_PORT "Shadowsocks 端口（留空则随机）" "$SING_BOX_SS_PORT" false
  fi
  if protocol_selected hy2; then prompt_value SING_BOX_HY2_PORT "Hysteria2 端口（留空则随机）" "$SING_BOX_HY2_PORT" false; fi
  if protocol_selected tuic; then prompt_value SING_BOX_TUIC_PORT "TUIC 端口（留空则随机）" "$SING_BOX_TUIC_PORT" false; fi
  if protocol_selected reality; then prompt_value SING_BOX_REALITY_PORT "VLESS Reality 端口（留空则随机）" "$SING_BOX_REALITY_PORT" false; fi
  if protocol_selected anytls; then prompt_value SING_BOX_ANYTLS_PORT "AnyTLS Reality 端口（留空则随机）" "$SING_BOX_ANYTLS_PORT" false; fi
  if protocol_selected reality || protocol_selected anytls; then
    prompt_value SING_BOX_REALITY_SNI "Reality SNI" "${SING_BOX_REALITY_SNI:-addons.mozilla.org}" true
  fi
  if protocol_selected vmess; then
    prompt_value SING_BOX_VMESS_PORT "VMess WebSocket 端口（留空则随机）" "$SING_BOX_VMESS_PORT" false
    prompt_value SING_BOX_VMESS_PATH "VMess WebSocket 路径" "${SING_BOX_VMESS_PATH:-/vmess}" true
    prompt_value SING_BOX_VMESS_HOST "VMess WebSocket Host（可留空）" "$SING_BOX_VMESS_HOST" false
  fi

  if [[ -z "$ENROLLMENT_TOKEN" ]]; then
    printf '一次性注册码: ' >/dev/tty
    IFS= read -r -s ENROLLMENT_TOKEN </dev/tty || die "failed to read enrollment token"
    printf '\n' >/dev/tty
  fi
  [[ -n "$ENROLLMENT_TOKEN" ]] || die "enrollment token cannot be empty"

  printf '\n安装摘要\n  Worker: %s\n  协议: %s\n  公网地址: %s\n  sing-box: %s\n' \
    "$SERVER_URL" "$SING_BOX_PROTOCOLS" "${SING_BOX_HOST:-自动识别}" "$SING_BOX_INSTALL_MODE" >/dev/tty
  local confirmation=""
  printf '确认开始安装？[Y/n]: ' >/dev/tty
  IFS= read -r confirmation </dev/tty || die "failed to read confirmation"
  case "$confirmation" in ""|y|Y|yes|YES) ;; *) log "installation cancelled"; exit 0 ;; esac
}

cleanup() {
  if [[ "$SCRUB_ENROLLMENT" == 1 && -f "$CONFIG_PATH" ]]; then sed -i '/^enrollmentToken:/d' "$CONFIG_PATH"; fi
  [[ -z "$TMP_DIR" ]] || rm -rf "$TMP_DIR"
  ENROLLMENT_TOKEN=""
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive)
      [[ "$MODE_OPTION" != non-interactive ]] || die "--interactive conflicts with --non-interactive"
      INSTALL_MODE="interactive"; MODE_OPTION="interactive"; shift ;;
    -y|--non-interactive)
      [[ "$MODE_OPTION" != interactive ]] || die "--non-interactive conflicts with --interactive"
      INSTALL_MODE="non-interactive"; MODE_OPTION="non-interactive"; shift ;;
    --server-url) [[ $# -ge 2 ]] || die "$1 requires a value"; SERVER_URL="$2"; shift 2 ;;
    --sing-box-binary) [[ $# -ge 2 ]] || die "$1 requires a value"; SING_BOX_BINARY="$2"; shift 2 ;;
    --install-sing-box)
      [[ "$SING_BOX_MODE_OPTION" != never ]] || die "--install-sing-box conflicts with --skip-sing-box-install"
      SING_BOX_INSTALL_MODE="always"; SING_BOX_MODE_OPTION="always"; shift ;;
    --skip-sing-box-install)
      [[ "$SING_BOX_MODE_OPTION" != always ]] || die "--skip-sing-box-install conflicts with --install-sing-box"
      SING_BOX_INSTALL_MODE="never"; SING_BOX_MODE_OPTION="never"; shift ;;
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
    --sing-box-config) die "--sing-box-config was removed; TunnelAtlas owns the generated configuration" ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run this script as root"
if [[ "$INSTALL_MODE" == interactive ]]; then
  interactive_wizard
else
  [[ -n "$SERVER_URL" ]] || die "--server-url is required in non-interactive mode"
  [[ -n "$ENROLLMENT_TOKEN" ]] || die "TUNNELATLAS_ENROLLMENT_TOKEN is required in non-interactive mode"
fi
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid GitHub repository"
[[ "$SING_BOX_INSTALL_MODE" =~ ^(auto|always|never)$ ]] || die "invalid sing-box install mode"
for command in awk curl grep install mktemp rm sed sha256sum tar uname; do command -v "$command" >/dev/null || die "required command not found: $command"; done
for value in "$SERVER_URL" "$SING_BOX_BINARY" "$SING_BOX_PROTOCOLS" "$SING_BOX_HOST" "$SING_BOX_REALITY_SNI" "$SING_BOX_SS_METHOD" "$SING_BOX_VMESS_PATH" "$SING_BOX_VMESS_HOST" "$VERSION" "$REPOSITORY"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "option values must fit on one line"
done
[[ "$ENROLLMENT_TOKEN" != *$'\n'* && "$ENROLLMENT_TOKEN" != *$'\r'* ]] || die "enrollment token must fit on one line"
if [[ "$SERVER_URL" != https://* && ! "$SERVER_URL" =~ ^http://(localhost|127\.0\.0\.1)([:/]|$) ]]; then
  die "--server-url must use HTTPS outside localhost"
fi
validate_port() {
  local value="$1"
  [[ -z "$value" ]] && return
  [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )) || die "invalid port: $value"
}
for port in "$SING_BOX_SS_PORT" "$SING_BOX_HY2_PORT" "$SING_BOX_TUIC_PORT" "$SING_BOX_REALITY_PORT" "$SING_BOX_ANYTLS_PORT" "$SING_BOX_VMESS_PORT"; do validate_port "$port"; done
declare -A configured_ports=()
validate_protocol_list || die "invalid or duplicate sing-box protocol list: $SING_BOX_PROTOCOLS"
record_protocol_port() {
  local protocol="$1" port="$2"
  protocol_selected "$protocol" || return 0
  [[ -n "$port" ]] || return 0
  [[ -z "${configured_ports[$port]+value}" ]] || die "duplicate configured protocol port: $port"
  configured_ports[$port]=1
}
record_protocol_port ss "$SING_BOX_SS_PORT"
record_protocol_port hy2 "$SING_BOX_HY2_PORT"
record_protocol_port tuic "$SING_BOX_TUIC_PORT"
record_protocol_port reality "$SING_BOX_REALITY_PORT"
record_protocol_port anytls "$SING_BOX_ANYTLS_PORT"
record_protocol_port vmess "$SING_BOX_VMESS_PORT"

if [[ -e "$CONFIG_DIR" || -e "$STATE_DIR" || -e "$BIN_PATH" || -e "$SYSTEMD_SERVICE_PATH" || -e "$OPENRC_SERVICE_PATH" ]]; then
  die "existing TunnelAtlas state detected; this installer supports clean installations only"
fi
if [[ -f /etc/sing-box/config.json ]]; then die "existing external sing-box configuration detected; clean the system before installing"; fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  INIT_SYSTEM="systemd"
  if systemctl is-active --quiet sing-box.service 2>/dev/null; then die "an external sing-box service is running; stop and remove it first"; fi
elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  INIT_SYSTEM="openrc"
  command -v supervise-daemon >/dev/null 2>&1 || die "OpenRC supervise-daemon is required"
  if [[ -x /etc/init.d/sing-box ]] && rc-service sing-box status >/dev/null 2>&1; then die "an external sing-box service is running; stop and remove it first"; fi
else
  die "neither a running systemd nor OpenRC installation was detected"
fi

case "$(uname -m)" in x86_64|amd64) ARCHITECTURE="x86_64" ;; aarch64|arm64) ARCHITECTURE="aarch64" ;; *) die "unsupported architecture" ;; esac
if [[ -e "/lib/ld-musl-${ARCHITECTURE}.so.1" ]] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then LIBC="musl"; else LIBC="gnu"; fi
PLATFORM="${ARCHITECTURE}-linux-${LIBC}"

if [[ "$VERSION" == latest ]]; then
  RELEASE_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest")"
  TAG="${RELEASE_URL##*/}"
else
  TAG="$VERSION"; [[ "$TAG" == v* ]] || TAG="v$TAG"
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid release version: $TAG"
VERSION_NUMBER="${TAG#v}"
ARCHIVE="tunnelatlasd-${VERSION_NUMBER}-${PLATFORM}.tar.gz"
BASE_URL="https://github.com/$REPOSITORY/releases/download/$TAG"
TMP_DIR="$(mktemp -d)"

log "downloading TunnelAtlas $TAG for $PLATFORM"
curl -fL --retry 3 -o "$TMP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE" || die "release asset unavailable"
curl -fL --retry 3 -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS" || die "release checksums unavailable"
EXPECTED_SUM="$(awk -v archive="$ARCHIVE" '$2 == archive || $2 == "./" archive { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
[[ "$EXPECTED_SUM" =~ ^[0-9a-fA-F]{64}$ ]] || die "archive checksum missing"
printf '%s  %s\n' "$EXPECTED_SUM" "$TMP_DIR/$ARCHIVE" | sha256sum -c -s - || die "release checksum verification failed"
tar -C "$TMP_DIR" --no-same-owner -xzf "$TMP_DIR/$ARCHIVE"
PACKAGE_DIR="$TMP_DIR/tunnelatlasd-${VERSION_NUMBER}-${PLATFORM}"
[[ -x "$PACKAGE_DIR/tunnelatlasd" ]] || die "release does not contain tunnelatlasd"

if [[ -z "$SING_BOX_BINARY" ]]; then SING_BOX_BINARY="$(command -v sing-box || true)"; fi
if [[ "$SING_BOX_INSTALL_MODE" == always || ( "$SING_BOX_INSTALL_MODE" == auto && ! -x "$SING_BOX_BINARY" ) ]]; then
  if command -v apk >/dev/null 2>&1; then
    apk update
    apk add --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community sing-box
  else
    curl -fL --retry 3 -o "$TMP_DIR/install-sing-box.sh" https://sing-box.app/install.sh || die "failed to download official sing-box installer"
    bash -n "$TMP_DIR/install-sing-box.sh"
    bash "$TMP_DIR/install-sing-box.sh"
  fi
  SING_BOX_BINARY="$(command -v sing-box || true)"
fi
[[ -n "$SING_BOX_BINARY" && -x "$SING_BOX_BINARY" ]] || die "sing-box binary not found"

if [[ "$INIT_SYSTEM" == systemd ]]; then
  systemctl disable --now sing-box.service >/dev/null 2>&1 || true
else
  [[ ! -x /etc/init.d/sing-box ]] || rc-service sing-box stop >/dev/null 2>&1 || true
  rc-update del sing-box default >/dev/null 2>&1 || true
fi

install -d -m 755 "$CONFIG_DIR" "$STATE_DIR"
install -m 755 "$PACKAGE_DIR/tunnelatlasd" "$BIN_PATH"
if [[ "$INIT_SYSTEM" == systemd ]]; then
  [[ -f "$PACKAGE_DIR/tunnelatlas.service" ]] || die "release does not contain tunnelatlas.service"
  install -m 644 "$PACKAGE_DIR/tunnelatlas.service" "$SYSTEMD_SERVICE_PATH"
else
  [[ -f "$PACKAGE_DIR/tunnelatlas.initd" ]] || die "release does not contain tunnelatlas.initd"
  install -m 755 "$PACKAGE_DIR/tunnelatlas.initd" "$OPENRC_SERVICE_PATH"
fi

[[ -n "$ENROLLMENT_TOKEN" ]] || die "enrollment token cannot be empty"

yaml_quote() { local escaped; escaped="$(printf '%s' "$1" | sed "s/'/''/g")"; printf "'%s'" "$escaped"; }
umask 077
SCRUB_ENROLLMENT=1
cat >"$CONFIG_PATH" <<EOF
serverUrl: $(yaml_quote "$SERVER_URL")
enrollmentToken: $(yaml_quote "$ENROLLMENT_TOKEN")
reportIntervalSeconds: 60
labels: {}
EOF
if [[ -n "$SING_BOX_HOST" ]]; then printf 'publicHost: %s\n' "$(yaml_quote "$SING_BOX_HOST")" >>"$CONFIG_PATH"; fi
cat >>"$CONFIG_PATH" <<EOF
runtimePath: '$STATE_DIR/runtime.json'
singBox:
  binaryPath: $(yaml_quote "$SING_BOX_BINARY")
  managedConfigPath: '$STATE_DIR/sing-box.json'
  secretsPath: '$STATE_DIR/secrets.json'
  certificatesDirectory: '$STATE_DIR/certificates'
  workingDirectory: '$STATE_DIR'
  restartDelaySeconds: 5
  shutdownTimeoutSeconds: 10
protocols: []
EOF
chmod 600 "$CONFIG_PATH"

add_protocol() {
  local protocol="$1" port="$2"
  local -a args=(protocol add "$protocol" --no-restart)
  [[ -z "$port" ]] || args+=(--port "$port")
  case "$protocol" in
    ss) [[ -z "$SING_BOX_SS_METHOD" ]] || args+=(--method "$SING_BOX_SS_METHOD") ;;
    reality|anytls) [[ -z "$SING_BOX_REALITY_SNI" ]] || args+=(--server-name "$SING_BOX_REALITY_SNI") ;;
    vmess) [[ -z "$SING_BOX_VMESS_PATH" ]] || args+=(--path "$SING_BOX_VMESS_PATH"); [[ -z "$SING_BOX_VMESS_HOST" ]] || args+=(--host "$SING_BOX_VMESS_HOST") ;;
  esac
  "$BIN_PATH" "${args[@]}"
}

protocols="$SING_BOX_PROTOCOLS"
[[ "$protocols" != all ]] || protocols="ss,hy2,tuic,reality,anytls,vmess"
IFS=',' read -r -a selected <<<"$protocols"
for protocol in "${selected[@]}"; do
  case "$protocol" in
    ss) add_protocol ss "$SING_BOX_SS_PORT" ;;
    hy2) add_protocol hy2 "$SING_BOX_HY2_PORT" ;;
    tuic) add_protocol tuic "$SING_BOX_TUIC_PORT" ;;
    reality) add_protocol reality "$SING_BOX_REALITY_PORT" ;;
    anytls) add_protocol anytls "$SING_BOX_ANYTLS_PORT" ;;
    vmess) add_protocol vmess "$SING_BOX_VMESS_PORT" ;;
    *) die "unsupported protocol: $protocol" ;;
  esac
done

"$BIN_PATH" config check
"$BIN_PATH" enroll
sed -i '/^enrollmentToken:/d' "$CONFIG_PATH"
SCRUB_ENROLLMENT=0
ENROLLMENT_TOKEN=""

if [[ "$INIT_SYSTEM" == systemd ]]; then
  systemctl daemon-reload
  systemctl enable --now tunnelatlas.service
  LOG_COMMAND="journalctl -u tunnelatlas.service -f"
else
  rc-update add tunnelatlas default
  rc-service tunnelatlas start
  LOG_COMMAND="rc-service tunnelatlas status"
fi
log "clean deployment completed; inspect service with: $LOG_COMMAND"
