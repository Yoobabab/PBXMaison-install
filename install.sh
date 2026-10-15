#!/usr/bin/env bash
# =============================================================================
#  PBXMaison — installation en une commande (Debian 12 ou Ubuntu 24.04, 64 bits)
#
#    curl -fsSL https://raw.githubusercontent.com/Yoobabab/PBXMaison-install/main/install.sh | sudo bash
#
#  Installe le moteur téléphonique (Asterisk 22 précompilé), la base, la console web,
#  le pare-feu et fail2ban, puis affiche l'adresse de l'assistant web.
#  La configuration du PBX (licence, certificat, mot de passe) se fait dans l'assistant.
#
#  Relancer la même commande met à jour le PBX sans perdre sa configuration.
#
#  Serveur multi-tenant (plusieurs PBX clients sur un seul VPS, tous en 5060) :
#    curl -fsSL …/install.sh | sudo bash -s -- --multi-tenant
#    curl -fsSL …/install.sh | sudo bash -s -- --multi-tenant --restaurer /root/callikoe-serveur-AAAAMMJJ-HHMMSS.tar.gz
# =============================================================================
set -Eeuo pipefail

MULTI=0; RESTORE_FILE=""; SERVER_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --multi-tenant) MULTI=1 ;;
    --restaurer) RESTORE_FILE="${2:-}"; shift ;;
    --serveur) SERVER_ARG="${2:-}"; shift ;;
  esac
  shift
done
[[ -f /etc/callikoe/tenants.json ]] && MULTI=1   # serveur déjà multi-tenant : la mise à jour garde ce mode

REPO="${PBXM_REPO:-Yoobabab/PBXMaison-install}"
REF="${PBXM_REF:-main}"
RELEASE_URL="https://github.com/${REPO}/releases/download/latest"
APP=/opt/pbxmaison
ETC=/etc/pbxmaison
VAR=/var/lib/pbxmaison
LOG=/var/log/pbxmaison-install.log
NODE_MAJOR=22

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B='' G='' Y='' R='' C='' N=''; fi
STEP=0; STEPS=9; WARNINGS=()
step() { STEP=$((STEP + 1)); echo; echo "${B}[$STEP/$STEPS] $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; WARNINGS+=("$*"); }
die()  { echo; echo "${R}✖ $*${N}" >&2; echo "  Journal : $LOG" >&2; exit 1; }
trap 'die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || die "Lance la commande avec sudo (… | sudo bash)."
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "${B}Callikoe — installation$( ((MULTI)) && echo " du serveur multi-tenant")${N} ($(date '+%F %T'))"
if ((MULTI)); then
  [[ -f /etc/pbxmaison/pbx.env ]] && die "Ce serveur héberge déjà un PBX seul. Le serveur multi-tenant s'installe sur un VPS neuf ; le PBX actuel y sera importé avec sa sauvegarde (callikoe-host importer)."
  [[ -z "$RESTORE_FILE" || -f "$RESTORE_FILE" ]] || die "Sauvegarde introuvable : ${RESTORE_FILE}"
  [[ -n "$SERVER_ARG$RESTORE_FILE" || -f /etc/callikoe/server-config.json ]] \
    || die "Il manque la configuration du serveur : copie la commande d'installation complète depuis le portail (onglet Serveurs multi-tenant)."
  ETC=/etc/callikoe
fi
export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -q --no-install-recommends "$@" >/dev/null; }
START=$SECONDS

# =============================================================================
step "Vérification de la machine"
# =============================================================================
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  debian:12) TARGET=debian12 ;;
  ubuntu:24.04) TARGET=ubuntu2404 ;;
  *) die "Système non pris en charge : ${PRETTY_NAME}. Choisis Debian 12 ou Ubuntu 24.04 (64 bits) pour le VPS." ;;
esac
[[ "$(dpkg --print-architecture)" == amd64 ]] || die "Processeur non pris en charge ($(dpkg --print-architecture)) : un VPS x86 64 bits (amd64) est nécessaire."
[[ -d /run/systemd/system ]] || die "systemd n'est pas actif sur cette machine."
IS_WSL=0; grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null && IS_WSL=1
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_GB=$(df -Pm / | awk 'NR==2 {print int($4/1024)}')
(( DISK_GB >= 3 )) || die "Espace disque insuffisant : ${DISK_GB} Go libres, 3 Go nécessaires."
(( MEM_MB >= 900 )) || warn "Mémoire faible (${MEM_MB} Mo) : 1 Go minimum conseillé."
ok "${PRETTY_NAME} · ${MEM_MB} Mo de RAM · ${DISK_GB} Go libres$( ((IS_WSL)) && echo ' · WSL (Windows)')"

# =============================================================================
step "Paquets système"
# =============================================================================
apt-get update -q >/dev/null
apt_install ca-certificates curl gnupg dnsutils iproute2 sudo tar openssl tcpdump
# Node.js du système (/usr/bin/node) : c'est lui qu'utilisent la console et pbx-configure
if [[ ! -x /usr/bin/node ]] || [[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q >/dev/null
fi
apt_install nodejs postgresql unixodbc odbc-postgresql alembic python3-alembic python3-psycopg2 nginx certbot fail2ban python3-systemd
((MULTI)) && apt_install kamailio kamailio-extra-modules conntrack
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge $NODE_MAJOR ]] || die "Node.js ${NODE_MAJOR} n'a pas pu être installé ($(/usr/bin/node -v))."
systemctl enable --now nginx >/dev/null 2>&1 || true
ok "Node.js $(/usr/bin/node -v), PostgreSQL, Nginx, Certbot, fail2ban"

# =============================================================================
step "Téléchargement de Callikoe"
# =============================================================================
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/${REPO}/archive/${REF}.tar.gz" -o "$TMP/app.tar.gz"
mkdir -p "$TMP/app" && tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" --strip-components=1
# On remplace le code mais pas les données (/etc/pbxmaison, /var/lib/pbxmaison)
rm -rf "$APP.new" && mv "$TMP/app" "$APP.new"
if [[ -d "$APP/console/node_modules" ]]; then mv "$APP/console/node_modules" "$APP.new/console/node_modules"; fi
rm -rf "$APP.old" && { [[ -d "$APP" ]] && mv "$APP" "$APP.old" || true; } && mv "$APP.new" "$APP" && rm -rf "$APP.old"
chmod 755 "$APP/pbx/bin/pbx-configure"
# Révision installée (menu Mises à jour de la console)
COMMIT="$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/${REPO}/commits/${REF}" 2>/dev/null | head -c 40 || true)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || COMMIT=""
ok "Code installé dans $APP (${REF}$([[ -n "$COMMIT" ]] && echo " · ${COMMIT:0:7}") · version $(cat "$APP/VERSION" 2>/dev/null || echo "?"))"

# =============================================================================
step "Moteur téléphonique (Asterisk précompilé)"
# =============================================================================
id asterisk >/dev/null 2>&1 || useradd --system --home-dir /var/lib/asterisk --no-create-home --shell /usr/sbin/nologin asterisk
WANT="$(curl -fsSL "${RELEASE_URL}/asterisk-${TARGET}-amd64.version")" || die "Archive Asterisk introuvable pour ${TARGET} (${RELEASE_URL})."
HAVE="$(cat /usr/share/asterisk/VERSION 2>/dev/null || true)"
if [[ "$HAVE" == "$WANT" ]]; then
  ok "Asterisk ${HAVE} déjà installé"
else
  curl -fsSL "${RELEASE_URL}/asterisk-${TARGET}-amd64.deps" -o "$TMP/deps"
  curl -fsSL "${RELEASE_URL}/asterisk-${TARGET}-amd64.tar.gz" -o "$TMP/asterisk.tar.gz"
  # shellcheck disable=SC2046
  apt_install $(cat "$TMP/deps")
  # --keep-directory-symlink : ne jamais remplacer les liens système (/var/run → /run, /lib → /usr/lib…)
  tar -xzf "$TMP/asterisk.tar.gz" -C / --no-same-owner --keep-directory-symlink --no-overwrite-dir \
    --exclude='./var/run' --exclude='var/run' --exclude='./run' --exclude='run'
  [[ -L /var/run ]] || die "Le lien /var/run a été modifié : installation interrompue par sécurité."
  ldconfig
  ok "Asterisk ${WANT} installé (sons en français inclus)"
fi
install -d -o asterisk -g asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk
chown -R asterisk:asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk
# Messagerie vocale lisible par la console (groupe asterisk) pour l'écoute dans le softphone
install -d -o asterisk -g asterisk -m 2770 /var/spool/asterisk/voicemail /var/spool/asterisk/voicemail/default
chmod -R g+rwX /var/spool/asterisk/voicemail
find /var/spool/asterisk/voicemail -type d -exec chmod g+s {} +
# Enregistrements des appels (lus par la console : groupe asterisk)
install -d -o asterisk -g asterisk -m 2770 /var/spool/asterisk/monitor /var/spool/asterisk/monitor/callikoe
((MULTI)) || cat > /etc/systemd/system/asterisk.service <<'EOF'
[Unit]
Description=Asterisk (Callikoe)
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service
ConditionPathExists=/etc/asterisk/asterisk.conf

[Service]
Type=simple
User=asterisk
Group=asterisk
UMask=0007
RuntimeDirectory=asterisk
RuntimeDirectoryMode=0775
ExecStart=/usr/sbin/asterisk -f -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx "core reload"
ExecStop=/usr/sbin/asterisk -rx "core stop gracefully"
TimeoutStopSec=30
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# =============================================================================
step "Base de données"
# =============================================================================
if ((MULTI)); then
  install -d -m 0755 "$ETC"
  systemctl enable --now postgresql >/dev/null 2>&1
  ok "PostgreSQL prêt (une base par PBX client)"
else
install -d -m 0750 "$ETC"
id pbxmaison >/dev/null 2>&1 || useradd --system --home-dir "$VAR" --no-create-home --shell /usr/sbin/nologin pbxmaison
chgrp pbxmaison "$ETC"
if [[ ! -f "$ETC/secrets.env" ]]; then
  umask 077
  cat > "$ETC/secrets.env" <<EOF
DB_PASSWORD='$(openssl rand -hex 24)'
AMI_SECRET='$(openssl rand -hex 24)'
ARI_PASSWORD='$(openssl rand -hex 24)'
SESSION_SECRET='$(openssl rand -hex 32)'
EOF
  umask 022
fi
chown root:pbxmaison "$ETC/secrets.env"; chmod 640 "$ETC/secrets.env"
set -a; . "$ETC/secrets.env"; set +a
systemctl enable --now postgresql >/dev/null 2>&1
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'asterisk') THEN
    CREATE ROLE asterisk LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE asterisk WITH LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END \$\$;
SQL
[[ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='asterisk'")" == 1 ]] || sudo -u postgres createdb -O asterisk asterisk
cat > /etc/odbc.ini <<EOF
[asterisk]
Description=PBXMaison
Driver=PostgreSQL Unicode
Database=asterisk
Servername=127.0.0.1
Port=5432
UserName=asterisk
Password=${DB_PASSWORD}
EOF
chmod 640 /etc/odbc.ini; chgrp asterisk /etc/odbc.ini
rm -rf "$TMP/dbm" && cp -a /usr/share/asterisk/ast-db-manage "$TMP/dbm"
sed "s#^sqlalchemy.url = .*#sqlalchemy.url = postgresql://asterisk:${DB_PASSWORD}@127.0.0.1/asterisk#" "$TMP/dbm/config.ini.sample" > "$TMP/dbm/config.ini"
(cd "$TMP/dbm" && alembic -c config.ini upgrade head >/dev/null)
ok "Base « asterisk » à jour"
fi

# =============================================================================
step "Console web"
# =============================================================================
if ((MULTI)); then :; else
install -d -o pbxmaison -g asterisk -m 2750 "$VAR"
install -d -o pbxmaison -g pbxmaison -m 0700 "$VAR/staging"
install -d -o pbxmaison -g asterisk -m 2750 "$VAR/sounds"
[[ -f "$VAR/extensions_routes.conf" ]] || install -o pbxmaison -g asterisk -m 0640 /dev/null "$VAR/extensions_routes.conf"
fi
# Modules Node.js : réinstallés seulement s'ils ont changé (npm ci repart de zéro et prend 1 à 2 min sur un petit VPS)
LOCKSUM="$(sha256sum "$APP/console/package-lock.json" | cut -c1-64)"
if [[ "$(cat "$APP/console/node_modules/.callikoe-lock" 2>/dev/null)" == "$LOCKSUM" ]]; then
  ok "Modules de la console déjà à jour"
else
  echo "  … installation des modules de la console (1 à 2 minutes)"
  (cd "$APP/console" && PATH="/usr/bin:$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1)
  echo "$LOCKSUM" > "$APP/console/node_modules/.callikoe-lock"
fi
if [[ -n "${PBXM_TRUSTED_KEY_FILE:-}" ]]; then install -m 0644 "$PBXM_TRUSTED_KEY_FILE" "$ETC/trusted-key.pem"; fi
if ((MULTI)); then
  chmod 755 "$APP/pbx/bin/callikoe-host"
  ln -sf "$APP/pbx/bin/callikoe-host" /usr/local/sbin/callikoe-host
  ok "Code installé ; une console par PBX client (callikoe-host)"
else
cat > /etc/sudoers.d/pbxmaison <<EOF
# La console web peut appliquer la configuration système, et rien d'autre
pbxmaison ALL=(root) NOPASSWD: ${APP}/pbx/bin/pbx-configure
EOF
chmod 440 /etc/sudoers.d/pbxmaison
visudo -cq -f /etc/sudoers.d/pbxmaison
cat > /etc/systemd/system/pbxmaison-console.service <<EOF
[Unit]
Description=Callikoe — console web
After=network-online.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=pbxmaison
Group=pbxmaison
SupplementaryGroups=asterisk
UMask=0007
EnvironmentFile=${ETC}/secrets.env
Environment=NODE_ENV=production PORT=8080 HOST=127.0.0.1
WorkingDirectory=${APP}/console
ExecStart=/usr/bin/node ${APP}/console/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
# Adresse <nom>.callikoe.fr tenue à jour (IP qui change) : au démarrage puis toutes les 6 h
cat > /etc/systemd/system/pbxmaison-dns.service <<EOF
[Unit]
Description=Callikoe — mise à jour de l'adresse du PBX
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${APP}/pbx/bin/pbx-configure dns
EOF
cat > /etc/systemd/system/pbxmaison-dns.timer <<EOF
[Unit]
Description=Callikoe — mise à jour régulière de l'adresse du PBX

[Timer]
OnBootSec=2min
OnUnitActiveSec=6h
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now pbxmaison-dns.timer >/dev/null 2>&1 || true
systemctl enable pbxmaison-console >/dev/null 2>&1
systemctl restart pbxmaison-console
ok "Console démarrée"
fi

# =============================================================================
step "Réseau et accès web"
# =============================================================================
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
PUBLIC_IP="${PBXM_PUBLIC_IP:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  for url in https://api.ipify.org https://ifconfig.me/ip https://ipv4.icanhazip.com; do
    PUBLIC_IP="$(curl -4 -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')" || true
    is_ipv4 "$PUBLIC_IP" && break; PUBLIC_IP=""
  done
fi
is_ipv4 "$PUBLIC_IP" || die "IP publique introuvable (relance avec PBXM_PUBLIC_IP=<ip> devant bash)."
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
BEHIND_NAT=0; [[ "$LOCAL_IP" != "$PUBLIC_IP" ]] && BEHIND_NAT=1
cat > "$ETC/install.state" <<EOF
PUBLIC_IP='${PUBLIC_IP}'
LOCAL_IP='${LOCAL_IP}'
BEHIND_NAT='${BEHIND_NAT}'
IS_WSL='${IS_WSL}'
OS_NAME='${PRETTY_NAME}'
INSTALLED_AT='$(date -Is)'
REPO='${REPO}'
REF='${REF}'
COMMIT='${COMMIT}'
EOF
chmod 644 "$ETC/install.state"
if ((MULTI)); then
  if [[ -n "$SERVER_ARG" ]]; then
    # Configuration du serveur signée par le portail (adresse de la console du serveur, compte super administrateur)
    SRVTMP="$(mktemp)"
    if [[ -f "$SERVER_ARG" ]]; then cp "$SERVER_ARG" "$SRVTMP"; else printf '%s' "$SERVER_ARG" | tr -d ' \n\r' | base64 -d > "$SRVTMP" 2>/dev/null || die "Configuration du serveur illisible : copie la commande en entier depuis le portail."; fi
    KEY="$APP/pbx/portal-public-key.pem"; [[ -f "$ETC/trusted-key.pem" ]] && KEY="$ETC/trusted-key.pem"
    node --input-type=module -e '
      import fs from "node:fs";const {verifySignature}=await import(process.argv[3]);
      let c;try{c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{console.error("JSON illisible");process.exit(1)}
      if(!verifySignature(c,fs.readFileSync(process.argv[2],"utf8"))){console.error("signature invalide");process.exit(1)}
      if(c.kind!=="server"||!c.pbx?.fqdn||!c.admin?.email){console.error("ce n est pas une configuration de serveur");process.exit(1)}' \
      "$SRVTMP" "$KEY" "$APP/pbx/lib/verify-config.mjs" 2>/dev/null || { rm -f "$SRVTMP"; die "Configuration du serveur refusée (signature ou contenu) : copie la commande depuis le portail."; }
    install -m 0644 "$SRVTMP" "$ETC/server-config.json"; rm -f "$SRVTMP"
    ok "Configuration du serveur vérifiée ($(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pbx.fqdn)' "$ETC/server-config.json"))"
  fi
  "$APP/pbx/bin/callikoe-host" init || die "Préparation du serveur multi-tenant impossible."
else
  "$APP/pbx/bin/pbx-configure" nginx
fi
systemctl enable nginx >/dev/null 2>&1
ok "IP publique ${PUBLIC_IP}$( ((BEHIND_NAT)) && echo " (machine derrière un routeur, IP locale ${LOCAL_IP})")"
((BEHIND_NAT)) && warn "Derrière une box : rediriger vers ${LOCAL_IP} UDP 5060, TCP 5060-5061, UDP 10000-20000, TCP 80/443/8822, et désactiver le SIP ALG."

# =============================================================================
step "Sécurité : pare-feu et fail2ban"
# =============================================================================
RTP_MAX=20000; ((MULTI)) && RTP_MAX=59999   # multi-tenant : 200 ports par PBX client
if ((IS_WSL)); then
  ok "Sous WSL : pare-feu de Windows"
elif [[ "${PBXM_NO_FIREWALL:-0}" == 1 ]]; then
  warn "Pare-feu non configuré (PBXM_NO_FIREWALL=1)"
elif command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 5060/udp >/dev/null; ufw allow 5060:5061/tcp >/dev/null; ufw allow "10000:${RTP_MAX}/udp" >/dev/null
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 8822/tcp >/dev/null
  ok "Règles ajoutées au pare-feu ufw existant"
else
  apt_install nftables
  SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1=="port" {print $2}' | paste -sd, -)"; SSH_PORTS="${SSH_PORTS:-22}"
  cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
# PBXMaison — pare-feu
flush ruleset
table inet pbxmaison {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept
    tcp dport { ${SSH_PORTS} } accept comment "SSH"
    tcp dport { 80, 443 } accept comment "Web public : softphone, appli, téléphones"
    tcp dport 8822 accept comment "Console d'administration"
    udp dport 5060 accept comment "SIP UDP"
    tcp dport { 5060, 5061 } accept comment "SIP TCP/TLS"
    udp dport 10000-${RTP_MAX} accept comment "Audio RTP"
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output { type filter hook output priority 0; policy accept; }
}
EOF
  nft -c -f /etc/nftables.conf && systemctl enable nftables >/dev/null 2>&1 && nft -f /etc/nftables.conf
  ok "Pare-feu actif (SSH port ${SSH_PORTS}, SIP, audio, web ; le reste est bloqué)"
fi
# Réglages gardés d'une installation à l'autre (modifiables dans la console : Sécurité)
if ((MULTI)); then
  : # jail de l'aiguilleur SIP écrite par callikoe-host init (adresses réelles des postes)
else
if ! grep -q "sshd" /etc/fail2ban/jail.d/pbxmaison.conf 2>/dev/null; then
  "$APP/pbx/bin/pbx-configure" f2b settings 5 10 60 "" >/dev/null || warn "Réglages fail2ban non écrits"
fi
touch /var/log/asterisk/security /var/log/asterisk/messages
chown asterisk:asterisk /var/log/asterisk/security /var/log/asterisk/messages
fi
systemctl restart fail2ban || warn "fail2ban n'a pas redémarré (journalctl -u fail2ban)"
ok "fail2ban actif (réglages : console › Sécurité)"

# =============================================================================
step "Assistant de configuration"
# =============================================================================
if ((MULTI)); then
  if [[ -n "$RESTORE_FILE" ]]; then
    "$APP/pbx/bin/callikoe-host" restaurer "$RESTORE_FILE" || die "Restauration du serveur impossible."
  else
    "$APP/pbx/bin/callikoe-host" mettre-a-jour || warn "Certains PBX clients n'ont pas redémarré (callikoe-host liste)"
  fi
  echo
  echo "${G}${B}✔ Serveur multi-tenant prêt en $(( (SECONDS - START) / 60 )) min $(( (SECONDS - START) % 60 )) s${N}"
  if ((${#WARNINGS[@]})); then echo; for w in "${WARNINGS[@]}"; do echo "  ${Y}⚠${N} $w"; done; fi
  echo
  "$APP/pbx/bin/callikoe-host" liste || true
  echo
  "$APP/pbx/bin/callikoe-host" console || true
  echo
  echo "  Ensuite : connecte-toi à la console du serveur et crée les PBX clients (bouton « Nouveau PBX »)."
  echo
  exit 0
fi
if [[ -f "$ETC/pbx.env" ]]; then
  "$APP/pbx/bin/pbx-configure" render
  systemctl restart asterisk 2>/dev/null || true
  set -a; . "$ETC/pbx.env"; set +a
  URL="https://${PBX_FQDN}:8822"; [[ -f "/etc/letsencrypt/live/${PBX_FQDN}/fullchain.pem" ]] || URL="http://${PUBLIC_IP}"
  ok "PBX déjà configuré (${PBX_NAME}) : mise à jour terminée"
else
  [[ -s "$VAR/setup-token" ]] || { openssl rand -hex 12 > "$VAR/setup-token"; }
  chown pbxmaison:pbxmaison "$VAR/setup-token"; chmod 600 "$VAR/setup-token"
  URL="http://${PUBLIC_IP}/?jeton=$(cat "$VAR/setup-token")"
  ok "Assistant prêt"
fi
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8080/api/health && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8080/api/health || warn "La console ne répond pas encore (journalctl -u pbxmaison-console)"

echo
echo "${G}${B}✔ Installation terminée en $(( (SECONDS - START) / 60 )) min $(( (SECONDS - START) % 60 )) s${N}"
if ((${#WARNINGS[@]})); then echo; for w in "${WARNINGS[@]}"; do echo "  ${Y}⚠${N} $w"; done; fi
echo
echo "  ${B}Ouvre cette adresse dans ton navigateur :${N}"
echo
echo "      ${C}${B}${URL}${N}"
echo
((BEHIND_NAT)) && [[ ! -f "$ETC/pbx.env" ]] && echo "  (depuis le réseau local : http://${LOCAL_IP}/?jeton=$(cat "$VAR/setup-token"))" && echo
exit 0
