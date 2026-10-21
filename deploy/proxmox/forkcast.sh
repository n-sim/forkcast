#!/usr/bin/env bash
# Forkcast household server for Proxmox VE: creates a Debian LXC container and
# installs the latest server release in it. Run on the Proxmox VE host as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/n-sim/forkcast/main/deploy/proxmox/forkcast.sh)"
#
# It asks before creating anything; choose "Advanced" to change the settings
# below, or set them in the environment (FORKCAST_YES=1 skips all questions):
#
#   CTID            container ID                (default: the next free ID)
#   CT_HOSTNAME     container host name         (default: forkcast)
#   CT_CORES        CPU cores                   (default: 1)
#   CT_MEMORY       memory in MiB               (default: 512)
#   CT_DISK         root disk in GiB            (default: 4)
#   CT_STORAGE      storage for the root disk   (default: local-lvm, or the first that fits)
#   CT_BRIDGE       network bridge              (default: vmbr0)
#   CT_IP           dhcp or a CIDR address      (default: dhcp)
#   CT_GATEWAY      gateway for a static address
#   FORKCAST_DOMAIN public name for automatic HTTPS through Caddy (default: none, plain HTTP on 8787)
#   FORKCAST_VERSION release to install         (default: the latest release)
#
# Upgrade later from the host with: pct exec <CTID> -- forkcast-update

set -Eeuo pipefail

SCRIPTS_URL="${FORKCAST_SCRIPTS_URL:-https://raw.githubusercontent.com/n-sim/forkcast/main/deploy/proxmox}"

msg_info() { printf ' \e[33m…\e[0m %s\n' "$*"; }
msg_ok() { printf ' \e[32m✔\e[0m %s\n' "$*"; }
msg_error() { printf ' \e[31m✘\e[0m %s\n' "$*" >&2; }
trap 'msg_error "Failed at line $LINENO: $BASH_COMMAND"' ERR

# Questions read from the terminal so the script also works through a pipe.
ask() { # ask <prompt> <default> -> answer
  local answer
  read -r -p "  $1 [$2]: " answer </dev/tty || true
  echo "${answer:-$2}"
}
confirm() { # confirm <prompt> (default yes)
  local answer
  read -r -p "  $1 [Y/n]: " answer </dev/tty || true
  [[ ! $answer =~ ^[Nn] ]]
}

printf '\n  \e[1mForkcast household server\e[0m for Proxmox VE\n\n'

[[ $EUID -eq 0 ]] || { msg_error "Run this as root on the Proxmox VE host."; exit 1; }
if ! command -v pct >/dev/null || ! command -v pveam >/dev/null; then
  msg_error "This is not a Proxmox VE host (pct and pveam are missing)."
  exit 1
fi
[[ $(uname -m) == x86_64 ]] || { msg_error "Forkcast server releases are built for x86-64 only."; exit 1; }

# Storage for container disks: local-lvm when it exists, else the first that can hold one.
default_storage() {
  local list
  list=$(pvesm status -content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }')
  if grep -qx local-lvm <<<"$list"; then echo local-lvm; else head -1 <<<"$list"; fi
}

CTID=${CTID:-$(pvesh get /cluster/nextid)}
CT_HOSTNAME=${CT_HOSTNAME:-forkcast}
CT_CORES=${CT_CORES:-1}
CT_MEMORY=${CT_MEMORY:-512}
CT_DISK=${CT_DISK:-4}
CT_STORAGE=${CT_STORAGE:-$(default_storage)}
CT_BRIDGE=${CT_BRIDGE:-vmbr0}
CT_IP=${CT_IP:-dhcp}
CT_GATEWAY=${CT_GATEWAY:-}
FORKCAST_DOMAIN=${FORKCAST_DOMAIN:-}
FORKCAST_VERSION=${FORKCAST_VERSION:-}

[[ -n $CT_STORAGE ]] || { msg_error "No active storage accepts container disks (content type rootdir)."; exit 1; }

summary() {
  cat <<EOF
  Container ID   $CTID
  Host name      $CT_HOSTNAME
  CPU / memory   $CT_CORES core(s), $CT_MEMORY MiB
  Disk           $CT_DISK GiB on $CT_STORAGE
  Network        $CT_BRIDGE, ${CT_IP}${CT_GATEWAY:+ via $CT_GATEWAY}
  HTTPS          ${FORKCAST_DOMAIN:-none (plain HTTP on port 8787)}
  Release        ${FORKCAST_VERSION:-latest}

EOF
}

if [[ ${FORKCAST_YES:-} != 1 ]]; then
  echo "  This creates an unprivileged Debian container running the Forkcast household server:"
  echo
  summary
  if ! confirm "Use these settings?"; then
    echo
    CTID=$(ask "Container ID" "$CTID")
    CT_HOSTNAME=$(ask "Host name" "$CT_HOSTNAME")
    CT_CORES=$(ask "CPU cores" "$CT_CORES")
    CT_MEMORY=$(ask "Memory (MiB)" "$CT_MEMORY")
    CT_DISK=$(ask "Disk (GiB)" "$CT_DISK")
    echo "  Storages: $(pvesm status -content rootdir | awk 'NR > 1 { print $1 }' | xargs)"
    CT_STORAGE=$(ask "Storage" "$CT_STORAGE")
    CT_BRIDGE=$(ask "Bridge" "$CT_BRIDGE")
    CT_IP=$(ask "IPv4 address (dhcp or e.g. 192.168.1.50/24)" "$CT_IP")
    if [[ $CT_IP != dhcp ]]; then CT_GATEWAY=$(ask "Gateway" "${CT_GATEWAY:-none}"); fi
    [[ $CT_GATEWAY == none ]] && CT_GATEWAY=""
    echo "  Installed apps connect only over HTTPS (or HTTP on the same machine). With a public"
    echo "  name that points at this container (ports 80 and 443), Caddy gets a certificate for it."
    FORKCAST_DOMAIN=$(ask "Public name for HTTPS (empty for none)" "${FORKCAST_DOMAIN:-none}")
    [[ $FORKCAST_DOMAIN == none ]] && FORKCAST_DOMAIN=""
    FORKCAST_VERSION=$(ask "Release (e.g. 0.0.9)" "${FORKCAST_VERSION:-latest}")
    [[ $FORKCAST_VERSION == latest ]] && FORKCAST_VERSION=""
    echo
    summary
    confirm "Create the container?" || { echo "  Nothing was changed."; exit 0; }
  fi
fi

[[ $CTID =~ ^[0-9]+$ ]] || { msg_error "Container ID must be a number."; exit 1; }
if pct status "$CTID" &>/dev/null || qm status "$CTID" &>/dev/null; then
  msg_error "ID $CTID is already in use."
  exit 1
fi

# The installer that runs inside the container, from beside this script when
# it is run from a checkout, otherwise from the repository.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
self=${BASH_SOURCE[0]:-}
if [[ -f $self && -f $(dirname "$self")/forkcast-install.sh ]]; then
  cp "$(dirname "$self")/forkcast-install.sh" "$work/forkcast-install.sh"
else
  curl -fsSL -o "$work/forkcast-install.sh" "$SCRIPTS_URL/forkcast-install.sh"
fi

msg_info "Finding the Debian container template"
template_storage=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1; exit }')
[[ -n $template_storage ]] || { msg_error "No active storage accepts container templates (content type vztmpl)."; exit 1; }
pveam update >/dev/null || true
template=$(pveam available --section system | awk '{ print $2 }' \
  | grep -E '^debian-(12|13)-standard_.*_amd64\.tar\.(gz|zst|xz)$' | sort -V | tail -1)
[[ -n $template ]] || { msg_error "No Debian 12 or 13 template is available from pveam."; exit 1; }
if ! pveam list "$template_storage" | grep -q "$template"; then
  msg_info "Downloading $template"
  pveam download "$template_storage" "$template" >/dev/null
fi
msg_ok "Template $template"

msg_info "Creating container $CTID"
net="name=eth0,bridge=$CT_BRIDGE,ip=$CT_IP${CT_GATEWAY:+,gw=$CT_GATEWAY}"
pct create "$CTID" "$template_storage:vztmpl/$template" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CT_CORES" \
  --memory "$CT_MEMORY" \
  --swap 512 \
  --rootfs "$CT_STORAGE:$CT_DISK" \
  --net0 "$net" \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  --tags forkcast \
  --description "Forkcast household server — https://github.com/n-sim/forkcast/blob/main/docs/server.md
Upgrade: pct exec $CTID -- forkcast-update" >/dev/null
msg_ok "Created container $CTID"

msg_info "Starting container $CTID"
pct start "$CTID"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts api.github.com &>/dev/null; then break; fi
  sleep 1
done
pct exec "$CTID" -- getent hosts api.github.com &>/dev/null \
  || { msg_error "Container $CTID has no network or DNS. Check the bridge and address settings."; exit 1; }
msg_ok "Started container $CTID"

pct push "$CTID" "$work/forkcast-install.sh" /usr/local/bin/forkcast-update --perms 0755
pct exec "$CTID" -- env \
  FORKCAST_DOMAIN="$FORKCAST_DOMAIN" \
  FORKCAST_VERSION="$FORKCAST_VERSION" \
  /usr/local/bin/forkcast-update

ip=$(pct exec "$CTID" -- hostname -I | awk '{ print $1 }')
echo
msg_ok "Forkcast is installed in container $CTID"
if [[ -n $FORKCAST_DOMAIN ]]; then
  echo "  Open https://$FORKCAST_DOMAIN/ once the name points at ${ip:-the container} (ports 80 and 443)."
else
  echo "  Open http://${ip:-<container address>}:8787/ in a browser to set up your household."
  echo "  Installed apps need HTTPS: put a reverse proxy in front (see docs/server.md), or rerun"
  echo "  inside the container with a public name: FORKCAST_DOMAIN=forkcast.example.com forkcast-update"
fi
echo "  Upgrade later with: pct exec $CTID -- forkcast-update"
echo
