#!/usr/bin/env bash
# =============================================================================
#  Callikoe — réinitialisation du serveur (VPS)
#
#    curl -fsSL https://raw.githubusercontent.com/Yoobabab/PBXMaison-install/main/reset.sh | sudo bash -s -- --confirmer
#
#  Efface tout ce que Callikoe a installé : console, configuration, base de données, utilisateurs,
#  messages vocaux, enregistrements, sauvegardes locales, configuration d'Asterisk et de Nginx.
#  Garde : les paquets installés (réinstallation plus rapide), le certificat HTTPS (limites Let's Encrypt),
#  le pare-feu et l'adresse <nom>.callikoe.fr réservée.
#  Ensuite, la commande d'installation du portail repart d'un serveur propre.
# =============================================================================
set -Euo pipefail

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B='' G='' Y='' R='' N=''; fi
ok()  { echo "  ${G}✔${N} $*"; }
die() { echo "${R}✖ $*${N}" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Lance la commande avec sudo (ou en root)."
CONFIRM=0; PURGE=0
for a in "$@"; do
  case "$a" in --confirmer) CONFIRM=1 ;; --tout) PURGE=1 ;; esac
done
if ((!CONFIRM)); then
  echo "${B}Réinitialisation de Callikoe${N}"
  echo "Tout sera effacé : utilisateurs, trunks, routages, messages vocaux, enregistrements, sauvegardes locales."
  echo "Pour confirmer, relance avec ${B}--confirmer${N} :"
  echo "  curl -fsSL https://raw.githubusercontent.com/Yoobabab/PBXMaison-install/main/reset.sh | sudo bash -s -- --confirmer"
  exit 1
fi

echo "${B}Réinitialisation de Callikoe…${N}"

# 0. Serveur multi-tenant : PBX clients, console du serveur, aiguilleur SIP
if [[ -d /etc/callikoe ]]; then
  for u in $(systemctl list-units --all --plain --no-legend 'callikoe-*' 2>/dev/null | awk '{print $1}'); do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
  for u in $(systemctl list-unit-files --plain --no-legend 'callikoe-*' 2>/dev/null | awk '{print $1}'); do systemctl disable "$u" >/dev/null 2>&1 || true; done
  systemctl disable --now kamailio >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/callikoe-*.service /etc/systemd/system/callikoe-*.timer
  nft delete table inet callikoe_geo >/dev/null 2>&1 || true
  if command -v psql >/dev/null && systemctl is-active --quiet postgresql; then
    for db in $(cd /tmp && sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'cx\_%' OR datname = 'callikoe_hub'" 2>/dev/null); do
      (cd /tmp && sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS \"$db\"" -c "DROP ROLE IF EXISTS \"$db\"") >/dev/null 2>&1 || true
    done
  fi
  for u in $(getent passwd | cut -d: -f1 | grep -E '^(cx-|ast-)[a-z0-9-]+$|^callikoe-hub$'); do userdel "$u" >/dev/null 2>&1 || true; done
  for g in $(getent group | cut -d: -f1 | grep -E '^cx-[a-z0-9-]+$|^callikoe-hub$'); do groupdel "$g" >/dev/null 2>&1 || true; done
  rm -rf /etc/callikoe /var/lib/callikoe /var/spool/callikoe /var/log/callikoe /usr/local/sbin/callikoe-host
  rm -f /etc/sudoers.d/callikoe-* /etc/nginx/sites-enabled/callikoe-* /etc/nginx/sites-available/callikoe-* \
        /etc/fail2ban/jail.d/callikoe.conf /etc/fail2ban/filter.d/callikoe-*.conf
  ok "Serveur multi-tenant effacé (PBX clients, console du serveur, aiguilleur SIP)"
fi

# 1. Services
for s in pbxmaison-console pbxmaison-dns.timer pbxmaison-dns pbxmaison-update asterisk; do
  systemctl disable --now "$s" >/dev/null 2>&1 || true
done
rm -f /etc/systemd/system/pbxmaison-console.service /etc/systemd/system/pbxmaison-dns.service \
      /etc/systemd/system/pbxmaison-dns.timer /etc/systemd/system/asterisk.service
systemctl daemon-reload
ok "Services arrêtés et supprimés"

# 2. Base de données
if command -v psql >/dev/null && systemctl is-active --quiet postgresql; then
  (cd /tmp && sudo -u postgres psql -q -c "DROP DATABASE IF EXISTS asterisk" -c "DROP ROLE IF EXISTS asterisk") >/dev/null 2>&1 || true
  ok "Base de données effacée"
fi

# 3. Fichiers
rm -rf /opt/pbxmaison /opt/pbxmaison.new /opt/pbxmaison.old /etc/pbxmaison /var/lib/pbxmaison \
       /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /run/asterisk
# Asterisk sera réextrait à la réinstallation (sons, musiques d'attente)
rm -f /usr/share/asterisk/VERSION
rm -f /etc/odbc.ini /etc/sudoers.d/pbxmaison /var/log/pbxmaison-update.log /var/log/pbxmaison-manual-ban.log /var/log/pbxmaison-install.log
ok "Configuration, messages vocaux, enregistrements et sauvegardes locales effacés"

# 4. Web et anti-intrusion
rm -f /etc/nginx/sites-enabled/pbxmaison /etc/nginx/sites-available/pbxmaison
if command -v nginx >/dev/null; then
  [[ -f /etc/nginx/sites-available/default ]] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
fi
rm -f /etc/fail2ban/jail.d/pbxmaison.conf /etc/fail2ban/filter.d/callikoe-manual.conf
systemctl restart fail2ban >/dev/null 2>&1 || true
ok "Site web et règles anti-intrusion de Callikoe retirés"

# 5. Comptes système
userdel pbxmaison >/dev/null 2>&1 || true
userdel asterisk >/dev/null 2>&1 || true
ok "Comptes système retirés"

# 6. Option --tout : retire aussi Asterisk (binaires) et les paquets installés
if ((PURGE)); then
  rm -rf /usr/sbin/asterisk /usr/lib/asterisk /usr/share/asterisk /usr/lib/x86_64-linux-gnu/libasterisk* 2>/dev/null || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y -q nodejs postgresql* unixodbc odbc-postgresql nginx* certbot fail2ban >/dev/null 2>&1 || true
  apt-get autoremove -y -q >/dev/null 2>&1 || true
  rm -rf /etc/letsencrypt /var/lib/postgresql
  ok "Paquets et certificats supprimés"
fi

echo
echo "${G}${B}Serveur réinitialisé.${N} Pour réinstaller : colle la commande d'installation du portail."
echo "${Y}Le certificat HTTPS et l'adresse .callikoe.fr sont conservés${N}$( ((PURGE)) && echo " (sauf certificat : --tout)")."
