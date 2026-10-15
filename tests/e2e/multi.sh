#!/usr/bin/env bash
# =============================================================================
#  Test de bout en bout du serveur multi-tenant (GitHub Actions, Ubuntu 24.04) :
#  install.sh --multi-tenant → deux PBX clients (clia, clib) avec le même poste 201 et chacun son trunk
#  → postes simulés et faux opérateur (instances Asterisk locales) → isolation, appels, sauvegarde/restauration.
#  Écrit le résultat dans multi-result.txt (une ligne par vérification).
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"
OUT="$PWD/multi-result.txt"; : > "$OUT"
pass() { echo "✔ $*" | tee -a "$OUT"; }
fail() { echo "✖ $*" | tee -a "$OUT"; exit 1; }
LAB="$PWD/multi-lab"; sudo rm -rf "$LAB"; mkdir -p "$LAB"

rm -f test-key-private.pem
node make-config.mjs . a.e2e.invalid cfg-a.json | tee -a "$OUT"
node make-config.mjs . b.e2e.invalid cfg-b.json | tee -a "$OUT"
IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"

# 1. Installation du serveur multi-tenant
T0=$SECONDS
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_TRUSTED_KEY_FILE="$PWD/test-key.pem" PBXM_NO_FIREWALL=1 PBXM_PUBLIC_IP="$IP" \
  timeout 1200 bash ../../install.sh --multi-tenant > install.out 2>&1 || { grep -v -E '\.{10}' install.out | tail -n 40 | cut -c1-200 >> "$OUT"; fail "install.sh --multi-tenant a échoué"; }
pass "install.sh --multi-tenant terminé en $(( SECONDS - T0 )) s"
sudo systemctl is-active --quiet kamailio && pass "Aiguilleur SIP (Kamailio) actif sur ${IP}:5060" || fail "kamailio arrêté"
sudo systemctl is-active --quiet asterisk 2>/dev/null && fail "un Asterisk « mono-PBX » tourne aussi" || pass "Pas d'Asterisk global : un moteur par client"

# 2. Deux PBX clients
for c in a b; do
  sudo /opt/pbxmaison/pbx/bin/callikoe-host creer "cli$c" "cfg-$c.json" > "creer-$c.out" 2>&1 || { tail -n 30 "creer-$c.out" | cut -c1-200 >> "$OUT"; fail "callikoe-host creer cli$c"; }
  grep -q "jeton=" "creer-$c.out" && pass "PBX cli$c créé (URL de création du compte affichée)" || { tail -n 20 "creer-$c.out" >> "$OUT"; fail "creer cli$c : pas d'URL"; }
  grep -E "✖" "creer-$c.out" | cut -c1-200 >> "$OUT" || true
done
B64="$(base64 -w0 cfg-a.json)"
sudo /opt/pbxmaison/pbx/bin/callikoe-host creer clic "$B64" > creer-c.out 2>&1 && fail "même adresse acceptée deux fois" || pass "Même adresse/licence qu'un autre PBX refusée (texte base64 du portail)"
L="$(sudo /opt/pbxmaison/pbx/bin/callikoe-host liste)"; echo "$L" | sed 's/^/   /' >> "$OUT"
for c in a b; do
  sudo systemctl is-active --quiet "callikoe-asterisk@cli$c" && sudo systemctl is-active --quiet "callikoe-console@cli$c" \
    && pass "cli$c : moteur et console actifs" || { sudo journalctl -u "callikoe-asterisk@cli$c" -u "callikoe-console@cli$c" -n 20 --no-pager | cut -c1-200 >> "$OUT"; fail "services cli$c"; }
done
astx() { sudo /usr/sbin/asterisk -C "/etc/callikoe/t/$1/asterisk/asterisk.conf" -rx "$2"; }

# Isolation système : un client ne lit ni les secrets ni la base d'un autre
sudo -u cx-clia cat /etc/callikoe/t/clib/secrets.env >/dev/null 2>&1 && fail "cx-clia lit les secrets de clib" || pass "Isolation : le compte de cli a ne lit pas les secrets de cli b"
PWA="$(sudo bash -c '. /etc/callikoe/t/clia/secrets.env; echo "$DB_PASSWORD"')"
PGPASSWORD="$PWA" psql -h 127.0.0.1 -U cx_clia -d cx_clib -Atc "SELECT 1" >/dev/null 2>&1 && fail "cx_clia ouvre la base de clib" || pass "Isolation : la base de cli b refuse le compte de cli a"
PGPASSWORD="$PWA" psql -h 127.0.0.1 -U cx_clia -d cx_clia -Atc "SELECT 1" >/dev/null 2>&1 && pass "cli a ouvre sa propre base" || fail "cx_clia n'ouvre pas sa base"
sudo -u cx-clia sudo -n /opt/pbxmaison/pbx/bin/pbx-configure --tenant clib status >/dev/null 2>&1 && fail "cx-clia agit sur clib" || pass "Isolation : la console de cli a ne peut pas configurer cli b (sudo)"

# Web : chaque adresse mène à sa console, une adresse inconnue à rien
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: a.e2e.invalid' http://127.0.0.1/api/health)" == 200 ]] && pass "Web : a.e2e.invalid → console de cli a" || fail "nginx a.e2e.invalid"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: inconnu.invalid' http://127.0.0.1/api/health)" == 404 ]] && pass "Web : adresse inconnue → 404" || fail "nginx adresse inconnue"

# 3. Compte administrateur, poste 201 et trunk de chaque client (API de sa console)
declare -A PW AUTH
for c in a b; do
  n=$([[ $c == a ]] && echo 1 || echo 2); API="http://127.0.0.1:$((9000 + n))"; JAR="$LAB/jar-$c"; : > "$JAR"
  TOKEN="$(sudo cat "/var/lib/callikoe/t/cli$c/setup-token")"
  TOTP="$(curl -sS -c "$JAR" -X POST "$API/api/setup/totp" -H "x-setup-token: $TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).secret||"")}catch{console.log(s.slice(0,200))}})')"
  [[ "$TOTP" =~ ^[A-Z2-7]{32}$ ]] || fail "cli$c totp : $TOTP"
  CODE="$(node -e 'import(process.argv[1]).then((a) => console.log(a.totpCode(process.argv[2], Math.floor(Date.now()/30000))))' "$PWD/../../console/lib/auth.mjs" "$TOTP")"
  R="$(curl -sS -b "$JAR" -c "$JAR" -X POST "$API/api/setup/admin" -H "x-setup-token: $TOKEN" -H "content-type: application/json" -d "{\"password\":\"MotDePasse2026\",\"totp_code\":\"$CODE\"}")"
  [[ "$R" == *'"ok":true'* ]] && pass "cli$c : compte administrateur créé" || fail "cli$c admin : $R"
  capi() { curl -sS -b "$JAR" -c "$JAR" -X "$1" "$API$2" ${3:+-H "content-type: application/json" -d "$3"}; }
  R="$(capi POST /api/extensions '{"number":"201","name":"Accueil"}')"
  PW[$c]="$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).password||"")}catch{}})')"
  AUTH[$c]="$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).auth_id||"")}catch{}})')"
  [[ -n "${PW[$c]}" && -n "${AUTH[$c]}" ]] && pass "cli$c : poste 201 créé" || fail "cli$c poste : $R"
  num=$([[ $c == a ]] && echo 0465001540 || echo 0465001550)
  R="$(capi POST /api/trunks "{\"template\":\"generique\",\"name\":\"op\",\"number\":\"$num\",\"username\":\"acct$c\",\"password\":\"pacct$c\",\"host\":\"127.0.0.50\",\"port\":5070}")"
  [[ "$R" == *'"id":"op"'* ]] && pass "cli$c : trunk « op » créé (même nom que chez l'autre client)" || fail "cli$c trunk : $R"
  [[ "$R" == *warning* ]] && echo "   $R" >> "$OUT"
  R="$(capi PUT /api/routes '{"inbound":["201"],"outbound_trunk":"op"}')"
  [[ "$R" == *'"outbound_trunk":"op"'* ]] || fail "cli$c routes : $R"
done
sudo cat /var/lib/callikoe/kamailio/db/tru | sed 's/^/   tru /' | sed -E 's/cx[0-9a-f]{16}/cx…/' >> "$OUT"
[[ "$(sudo grep -c 'sip\\:127.0.0.1\\:6001' /var/lib/callikoe/kamailio/db/tru)" -ge 2 && "$(sudo grep -c 'sip\\:127.0.0.1\\:6002' /var/lib/callikoe/kamailio/db/tru)" -ge 2 ]] \
  && pass "Aiguilleur : compte de trunk et SDA de chaque client publiés" || fail "table tru incomplète"

# 4. Faux opérateur et postes simulés (instances Asterisk séparées, en root)
mkast() { # mkast <nom> <pjsip.conf> <extensions.conf> <rtpstart>
  local d="$LAB/$1"; mkdir -p "$d/etc" "$d/lib" "$d/spool" "$d/run" "$d/log"
  cat > "$d/etc/asterisk.conf" <<EOF
[directories]
astetcdir => $d/etc
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => $d/lib
astdbdir => $d/lib
astkeydir => $d/lib
astdatadir => /var/lib/asterisk
astagidir => /var/lib/asterisk/agi-bin
astspooldir => $d/spool
astrundir => $d/run
astlogdir => $d/log
astsbindir => /usr/sbin
[options]
documentation_language = en_US
EOF
  printf '%s\n' "$2" > "$d/etc/pjsip.conf"; printf '%s\n' "$3" > "$d/etc/extensions.conf"
  printf '[general]\nrtpstart=%s\nrtpend=%s\n' "$4" "$(( $4 + 99 ))" > "$d/etc/rtp.conf"
  printf '[general]\n[logfiles]\nmessages => notice,warning,error,verbose\n' > "$d/etc/logger.conf"
  cat > "$d/etc/modules.conf" <<'EOF'
[modules]
autoload = yes
noload => res_odbc.so
noload => res_config_odbc.so
noload => cdr_adaptive_odbc.so
noload => cel_odbc.so
noload => res_pjsip_phoneprov_provider.so
noload => res_phoneprov.so
noload => chan_iax2.so
noload => res_ari.so
noload => res_http_websocket.so
noload => res_pjsip_transport_websocket.so
noload => res_statsd.so
noload => res_xmpp.so
noload => res_hep.so
noload => res_hep_pjsip.so
noload => res_hep_rtcp.so
noload => res_stasis.so
noload => pbx_lua.so
noload => pbx_ael.so
noload => res_config_ldap.so
noload => res_config_pgsql.so
noload => cdr_pgsql.so
noload => cel_pgsql.so
EOF
  sudo /usr/sbin/asterisk -C "$d/etc/asterisk.conf"
}
labx() { sudo /usr/sbin/asterisk -C "$LAB/$1/etc/asterisk.conf" -rx "$2"; }
OPACCT() { cat <<EOF
[$1]
type = endpoint
context = op-in
aors = $1
auth = $1
disallow = all
allow = ulaw,alaw
direct_media = no
[$1]
type = aor
max_contacts = 1
remove_existing = yes
[$1]
type = auth
auth_type = userpass
username = $1
password = p$1
EOF
}
mkast op "[global]
type = global
endpoint_identifier_order = auth_username,username,ip
[transport-udp]
type = transport
protocol = udp
bind = 127.0.0.50:5070
$(OPACCT accta)
$(OPACCT acctb)" "[op-in]
exten => _X.,1,Set(GLOBAL(LASTOUT)=\${CHANNEL(endpoint)}:\${EXTEN})
 same => n,Answer()
 same => n,Wait(3)
 same => n,Hangup()
[wait]
exten => s,1,Answer()
 same => n,Wait(5)
 same => n,Hangup()" 30000
PHONE() { # PHONE <ip> <domaine> <identifiant> <mot de passe>
  cat <<EOF
[global]
type = global
[transport-udp]
type = transport
protocol = udp
bind = $1:5080
[pbx]
type = endpoint
context = answer
aors = pbx
outbound_auth = pbx-auth
outbound_proxy = sip:${IP}:5060\;lr
from_user = 201
from_domain = $2
disallow = all
allow = ulaw,alaw
direct_media = no
[pbx]
type = aor
contact = sip:$2
[pbx-auth]
type = auth
auth_type = userpass
username = $3
password = $4
[reg]
type = registration
server_uri = sip:$2
client_uri = sip:201@$2
contact_user = 201
outbound_auth = pbx-auth
outbound_proxy = sip:${IP}:5060\;lr
retry_interval = 5
forbidden_retry_interval = 5
max_retries = 1000
expiration = 120
[pbx-id]
type = identify
endpoint = pbx
match = ${IP}
EOF
}
ANSWER='[answer]
exten => _[a-z0-9].,1,Set(GLOBAL(RANG)=${EXTEN})
 same => n,Answer()
 same => n,Wait(4)
 same => n,Set(GLOBAL(RTPRX)=${CHANNEL(rtcp,rxcount)})
 same => n,Hangup()
[wait]
exten => s,1,Answer()
 same => n,Wait(5)
 same => n,Hangup()'
# Traces SIP (lues seulement en cas d'échec)
for c in clia clib; do astx $c "logger add channel sipdebug notice,warning,error,verbose" >/dev/null; astx $c "core set verbose 3" >/dev/null; astx $c "pjsip set logger on" >/dev/null; done
sipdump() { # sipdump <PBX client> : échanges SIP vus par son moteur
  echo "== SIP vu par $1" >> "$OUT"
  sudo grep -E "<--- |---> |^(REGISTER|INVITE|SIP/2.0|Via|Route|Path|Contact|To|From|Supported|Require|Authorization|WWW-Authenticate|Unsupported)" "/var/log/callikoe/$1/sipdebug" 2>/dev/null | cut -c1-200 | head -n 70 >> "$OUT" || true
  sudo grep -iE "WARNING|ERROR|NOTICE" "/var/log/callikoe/$1/messages" 2>/dev/null | tail -n 10 | cut -c1-200 >> "$OUT" || true
  sudo journalctl -u kamailio --no-pager | grep -E "CALLIKOE|ERROR|WARN" | grep -v reparse_on_dns | tail -n 10 | cut -c1-200 >> "$OUT" || true
}
mkast pa "$(PHONE 127.0.0.11 a.e2e.invalid "${AUTH[a]}" "${PW[a]}")" "$ANSWER" 31000
mkast pb "$(PHONE 127.0.0.12 b.e2e.invalid "${AUTH[b]}" "${PW[b]}")" "$ANSWER" 31100
# Poste pirate : identifiants de cli a, présentés au domaine de cli b
mkast px "$(PHONE 127.0.0.13 b.e2e.invalid "${AUTH[a]}" "${PW[a]}")" "$ANSWER" 31200

waitfor() { # waitfor <secondes> <commande…>
  local t=$1; shift; for _ in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}
regd() { labx "$1" "pjsip show registrations" | grep -q "Registered"; }
waitfor 40 regd pa && pass "Poste 201 de cli a enregistré (via l'aiguilleur, domaine a.e2e.invalid)" || { labx pa "pjsip show registrations" >> "$OUT"; sipdump clia; fail "poste A non enregistré"; }
waitfor 40 regd pb && pass "Poste 201 de cli b enregistré (même numéro, autre PBX)" || { labx pb "pjsip show registrations" >> "$OUT"; sipdump clib; fail "poste B non enregistré"; }
astx clia "pjsip show contacts" | grep -q "201/" && ! astx clib "pjsip show contacts" | grep -q "127.0.0.11" && pass "Chaque poste est connu de son seul PBX" || fail "contacts mélangés"
sleep 8
regd px && fail "poste pirate enregistré chez cli b avec les identifiants de cli a" || pass "Poste de cli a refusé par cli b (identifiants d'un autre PBX)"
sudo journalctl -u kamailio --no-pager | grep -q "CALLIKOE-AUTHFAIL 127.0.0.13" && pass "Échec noté avec l'adresse réelle du poste pirate (fail2ban)" || { sudo journalctl -u kamailio -n 30 --no-pager | cut -c1-200 >> "$OUT"; fail "AUTHFAIL absent"; }
labx px "module unload res_pjsip_outbound_registration.so" >/dev/null 2>&1 || true

opreg() { labx op "pjsip show contacts" | grep -q "$1/"; }
waitfor 60 opreg accta && waitfor 60 opreg acctb && pass "Trunks des deux clients enregistrés chez l'opérateur (via l'aiguilleur)" || { labx op "pjsip show contacts" >> "$OUT"; astx clia "pjsip show registrations" >> "$OUT"; sipdump clia; fail "trunks non enregistrés"; }
labx op "pjsip show contacts" | grep -qE "cx[0-9a-f]{16}" && pass "Contact du trunk = jeton propre au client" || { labx op "pjsip show contacts" >> "$OUT"; fail "contact sans jeton"; }

glob() { labx "$1" "dialplan show globals" | sed -nE "s/^\s*$2=(.*)$/\1/p" | head -n1; }
reset() { labx pa "dialplan set global RANG none" >/dev/null; labx pb "dialplan set global RANG none" >/dev/null; labx op "dialplan set global LASTOUT none" >/dev/null; }

# 5. Appels entrants : opérateur → trunk de A → poste 201 de A (et pas celui de B)
reset; labx op "channel originate PJSIP/accta extension s@wait" >/dev/null; sleep 9
[[ "$(glob pa RANG)" == 201 && "$(glob pb RANG)" == none ]] && pass "Entrant sur le trunk de cli a → poste 201 de cli a uniquement" || { echo "RANG A=$(glob pa RANG) B=$(glob pb RANG)" >> "$OUT"; sipdump clia; fail "entrant A"; }
[[ "$(glob pa RTPRX)" =~ ^[0-9]+$ && "$(glob pa RTPRX)" -gt 50 ]] && pass "Son reçu par le poste de cli a ($(glob pa RTPRX) paquets RTP)" || echo "   (RTP poste A : $(glob pa RTPRX))" >> "$OUT"
reset; labx op "channel originate PJSIP/acctb extension s@wait" >/dev/null; sleep 9
[[ "$(glob pb RANG)" == 201 && "$(glob pa RANG)" == none ]] && pass "Entrant sur le trunk de cli b → poste 201 de cli b uniquement" || { echo "RANG A=$(glob pa RANG) B=$(glob pb RANG)" >> "$OUT"; fail "entrant B"; }
# Appel « pirate » vers la SDA de A, sans le jeton du trunk : refusé
reset; labx px "channel originate PJSIP/0465001540@pbx extension s@wait" >/dev/null 2>&1 || true; sleep 6
[[ "$(glob pa RANG)" == none ]] && pass "Appel vers la SDA de cli a sans le jeton de son trunk : refusé" || fail "appel pirate arrivé chez A"

# 6. Appels sortants : chaque poste sort par le trunk de son PBX
reset; labx pa "channel originate PJSIP/0412345678@pbx extension s@wait" >/dev/null; sleep 8
[[ "$(glob op LASTOUT)" == "accta:0412345678" ]] && pass "Sortant de cli a → opérateur, compte de cli a" || { echo "LASTOUT=$(glob op LASTOUT)" >> "$OUT"; sipdump clia; fail "sortant A"; }
reset; labx pb "channel originate PJSIP/0412345678@pbx extension s@wait" >/dev/null; sleep 8
[[ "$(glob op LASTOUT)" == "acctb:0412345678" ]] && pass "Sortant de cli b → opérateur, compte de cli b" || { echo "LASTOUT=$(glob op LASTOUT)" >> "$OUT"; fail "sortant B"; }
astx clia "pjsip show endpoints" | grep -qE "Endpoint:\s+op" && ! astx clia "pjsip show endpoints" | grep -q "acctb" && pass "Le PBX de cli a ne voit que son trunk" || fail "endpoints A"

# 7. Sauvegarde du serveur entier → suppression de cli b → restauration (commande PuTTY)
sudo /opt/pbxmaison/pbx/bin/callikoe-host sauvegarder > bk.out 2>&1 || { tail -n 20 bk.out >> "$OUT"; fail "sauvegarder"; }
BK="$(sudo cat /var/lib/callikoe/last-backup)"
sudo tar -tzf "$BK" | grep -q "tenants/clib.tar.gz" && pass "Sauvegarde du serveur : $(basename "$BK") ($(sudo du -h "$BK" | cut -f1))" || fail "archive serveur incomplète"
sudo /opt/pbxmaison/pbx/bin/callikoe-host supprimer clib > /dev/null 2>&1 && fail "suppression sans --confirmer" || pass "Suppression refusée sans --confirmer"
sudo /opt/pbxmaison/pbx/bin/callikoe-host supprimer clib --confirmer > del.out 2>&1 || { tail -n 20 del.out >> "$OUT"; fail "supprimer"; }
! id cx-clib >/dev/null 2>&1 && ! sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='cx_clib'" | grep -q 1 && pass "cli b supprimé (comptes, base, fichiers)" || fail "restes de clib"
sudo cp "$BK" /root/sauvegarde-test.tar.gz
sudo /opt/pbxmaison/pbx/bin/callikoe-host restaurer /root/sauvegarde-test.tar.gz > rs.out 2>&1 || { tail -n 30 rs.out | cut -c1-200 >> "$OUT"; fail "restaurer"; }
grep -q "clia existe déjà" rs.out && pass "Restauration : cli a (déjà présent) laissé tel quel" || true
waitfor 30 sudo systemctl is-active --quiet callikoe-asterisk@clib && pass "cli b restauré : moteur actif" || { sudo journalctl -u callikoe-asterisk@clib -n 20 --no-pager >> "$OUT"; fail "clib non restauré"; }
waitfor 60 regd pb && pass "Poste 201 de cli b de nouveau enregistré (mêmes identifiants)" || { labx pb "pjsip show registrations" >> "$OUT"; fail "poste B après restauration"; }
waitfor 90 opreg acctb && reset && labx op "channel originate PJSIP/acctb extension s@wait" >/dev/null && sleep 9 && [[ "$(glob pb RANG)" == 201 ]] \
  && pass "Entrant vers cli b après restauration" || { echo "RANG B=$(glob pb RANG)" >> "$OUT"; sudo cat /var/lib/callikoe/kamailio/db/tru >> "$OUT"; fail "entrant B après restauration"; }
R="$(curl -sS -X POST http://127.0.0.1:9002/api/login -H "content-type: application/json" -d '{"email":"admin@test.invalid","password":"MotDePasse2026"}')"
[[ "$R" == *ticket* ]] && pass "Compte administrateur de cli b retrouvé après restauration" || fail "login clib : $R"

for d in op pa pb px; do labx "$d" "core stop now" >/dev/null 2>&1 || true; done
pass "Serveur multi-tenant validé"
