#!/usr/bin/env bash
# =============================================================================
#  Test de bout en bout du serveur multi-tenant (GitHub Actions, Ubuntu 24.04), dans l'ordre réel :
#  install.sh --multi-tenant --serveur (config signée du portail) → console du serveur (compte super administrateur,
#  double authentification) → création de deux PBX clients depuis la console du serveur → ouverture de chaque PBX
#  sans se reconnecter → postes, trunks → postes simulés et faux opérateur → isolation, appels → sauvegarde/restauration.
#  Écrit le résultat dans multi-result.txt (une ligne par vérification).
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"
OUT="$PWD/multi-result.txt"; : > "$OUT"
pass() { echo "✔ $*" | tee -a "$OUT"; }
fail() { echo "✖ $*" | tee -a "$OUT"; exit 1; }
LAB="$PWD/multi-lab"; sudo rm -rf "$LAB"; mkdir -p "$LAB"
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")}catch{console.log("")}})' "$1"; }
LASTSTEP_FILE="$(mktemp)"; echo 0 > "$LASTSTEP_FILE"
otp() { # otp <secret> : code TOTP, jamais deux fois le même pas de 30 s
  local st; while :; do st=$(( $(date +%s) / 30 )); (( st > $(cat "$LASTSTEP_FILE") )) && break; sleep 2; done
  echo "$st" > "$LASTSTEP_FILE"
  node -e 'import(process.argv[1]).then((a) => console.log(a.totpCode(process.argv[2], Number(process.argv[3]))))' "$PWD/../../console/lib/auth.mjs" "$1" "$st"
}

rm -f test-key-private.pem
node make-config.mjs . a.e2e.invalid cfg-a.json | tee -a "$OUT"
node make-config.mjs . b.e2e.invalid cfg-b.json | tee -a "$OUT"
node make-config.mjs . hub.e2e.invalid cfg-srv.json --serveur | tee -a "$OUT"
IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"

# 1. Installation du serveur multi-tenant (commande donnée par le portail)
T0=$SECONDS
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_TRUSTED_KEY_FILE="$PWD/test-key.pem" PBXM_NO_FIREWALL=1 PBXM_PUBLIC_IP="$IP" \
  timeout 600 bash ../../install.sh --multi-tenant > install-sans.out 2>&1 && fail "installation acceptée sans configuration du serveur" \
  || pass "Installation refusée sans la configuration du serveur (commande incomplète)"
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_TRUSTED_KEY_FILE="$PWD/test-key.pem" PBXM_NO_FIREWALL=1 PBXM_NO_AUTOUPDATE=1 PBXM_PUBLIC_IP="$IP" \
  timeout 1200 bash ../../install.sh --multi-tenant --serveur "$(base64 -w0 cfg-srv.json)" > install.out 2>&1 || { grep -v -E '\.{10}' install.out | tail -n 40 | cut -c1-200 >> "$OUT"; fail "install.sh --multi-tenant a échoué"; }
pass "install.sh --multi-tenant --serveur terminé en $(( SECONDS - T0 )) s"
grep -q "Première connexion" install.out && pass "Lien de première connexion à la console du serveur affiché" || { tail -n 15 install.out >> "$OUT"; fail "lien de la console du serveur absent"; }
sudo systemctl is-active --quiet kamailio && pass "Aiguilleur SIP (Kamailio) actif sur ${IP}:5060" || fail "kamailio arrêté"
sudo fail2ban-client status callikoe-sip >/dev/null 2>&1 && sudo fail2ban-client status callikoe-sip-unknown >/dev/null 2>&1 \
  && pass "Anti-intrusion SIP actif (bannit seulement le SIP : SSH et web restent joignables)" || { sudo journalctl -u fail2ban -n 15 --no-pager | cut -c1-200 >> "$OUT"; fail "jails fail2ban"; }
if sudo nft list table inet callikoe_geo >/dev/null 2>&1; then pass "Pays autorisés : téléphonie acceptée seulement depuis la France (par défaut), opérateurs et réseau local toujours acceptés"
else echo "   (filtre des pays non appliqué : $(sudo cat /var/lib/callikoe/geo/etat.json 2>/dev/null | cut -c1-200))" >> "$OUT"; fi
sudo systemctl is-active --quiet callikoe-hub && pass "Console du serveur active" || { sudo journalctl -u callikoe-hub -n 20 --no-pager | cut -c1-200 >> "$OUT"; fail "console du serveur arrêtée"; }
sudo systemctl is-active --quiet asterisk 2>/dev/null && fail "un Asterisk « mono-PBX » tourne aussi" || pass "Pas d'Asterisk global : un moteur par client"

# 2. Console du serveur : compte super administrateur (double authentification), connexion
HUB=http://127.0.0.1:8800; HJAR="$LAB/jar-hub"; : > "$HJAR"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: hub.e2e.invalid' http://127.0.0.1/api/state)" == 200 ]] && pass "Web : hub.e2e.invalid → console du serveur" || fail "nginx console du serveur"
HTOKEN="$(sudo cat /var/lib/callikoe/hub/setup-token)"
hapi() { curl -sS -b "$HJAR" -c "$HJAR" -X "$1" "$HUB$2" ${3:+-H "content-type: application/json" -d "$3"}; }
R="$(curl -sS -X POST "$HUB/api/setup/totp" -H "x-setup-token: mauvais-jeton-0000000000000000")"
[[ "$R" == *"invalide"* ]] && pass "Console du serveur : mauvais lien de première connexion refusé" || fail "jeton faux accepté : $R"
HTOTP="$(curl -sS -c "$HJAR" -X POST "$HUB/api/setup/totp" -H "x-setup-token: $HTOKEN" | jget secret)"
[[ "$HTOTP" =~ ^[A-Z2-7]{32}$ ]] || fail "totp console du serveur : $HTOTP"
R="$(curl -sS -b "$HJAR" -c "$HJAR" -X POST "$HUB/api/setup/admin" -H "x-setup-token: $HTOKEN" -H "content-type: application/json" -d "{\"name\":\"IRT\",\"password\":\"MotDePasse2026\",\"totp_code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"recovery_codes":['* ]] && pass "Console du serveur : super administrateur créé (double authentification, codes de secours)" || fail "super admin : $R"
: > "$HJAR"
R="$(hapi GET /api/pbx)"; [[ "$R" == *"Session"* ]] && pass "Console du serveur : rien sans connexion" || fail "accès sans session : $R"
T="$(hapi POST /api/login '{"email":"irt-admin@test.invalid","password":"MotDePasse2026"}' | jget ticket)"
[[ -n "$T" ]] || fail "login console du serveur"
R="$(hapi POST /api/login/totp "{\"ticket\":\"$T\",\"code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"ok":true'* ]] && pass "Connexion à la console du serveur (mot de passe + code)" || fail "login totp : $R"
R="$(hapi POST /api/pays '{"countries":["FR","BE"],"always":["203.0.113.9"]}')"
[[ "$R" == *'"countries":["FR","BE"]'* && "$R" == *'"always":["203.0.113.9"]'* ]] && pass "Pays autorisés : France + Belgique et une adresse toujours acceptée, réglés depuis la console du serveur" || { echo "$R" | cut -c1-300 >> "$OUT"; fail "pays autorisés"; }

# 3. Création des deux PBX depuis la console du serveur
hjob() { # hjob <id> [silencieux] : attend la fin d'une tâche ; sortie dans le résultat en cas d'échec
  local j; for _ in $(seq 1 150); do j="$(hapi GET "/api/jobs/$1")"; [[ "$j" == *'"running":false'* ]] && break; sleep 2; done
  echo "$j" > "$LAB/job-$1.json"
  [[ "$j" == *'"ok":true'* ]] || { [[ -n "${2:-}" ]] && return 1; echo "$j" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of JSON.parse(s).lines||[])console.log("   "+l)})' | cut -c1-200 >> "$OUT"; return 1; }
}
R="$(hapi POST /api/pbx/new '{"slug":"clia","name":"PBX A"}')"
[[ "$R" == *"clé de signature"* ]] && pass "Création bloquée tant que la clé de signature n'est pas installée" || fail "création sans clé : $R"
KEYJSON="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' test-key-private.pem)"
R="$(hapi POST /api/signing "{\"pem\":$KEYJSON,\"code\":\"000000\"}")"
[[ "$R" == *"incorrect"* ]] && pass "Clé de signature : code de double authentification exigé" || fail "clé sans code : $R"
OTHER="$(node -e 'const c=require("crypto");process.stdout.write(JSON.stringify(c.generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"})))')"
R="$(hapi POST /api/signing "{\"pem\":$OTHER,\"code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *"pas reconnue"* ]] && pass "Clé de signature étrangère refusée (pas celle d'IRT)" || fail "clé étrangère acceptée : $R"
R="$(hapi POST /api/signing "{\"pem\":$KEYJSON,\"code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"configured":true'* ]] && pass "Clé de signature des licences installée sur la console du serveur" || fail "clé : $R"
sudo test "$(sudo stat -c '%U %a' /var/lib/callikoe/hub/portal-key.pem)" == "callikoe-hub 600" && pass "Clé de signature lisible par la console du serveur seulement" || fail "droits de la clé : $(sudo stat -c '%U %a' /var/lib/callikoe/hub/portal-key.pem)"
NEWPBX() { # NEWPBX <slug> <fqdn> <nom>
  printf '{"slug":"%s","name":"%s","company":"%s SARL","phone":"04 12 34 56 78","domain":"custom","fqdn":"%s","country":"FR","timezone":"Europe/Paris","language":"fr","edition":"pro","simultaneous_calls":"8","duration_months":"12","admin_email":"contact@%s"}' "$1" "$3" "$3" "$2" "$2"
}
for c in a b; do
  R="$(hapi POST /api/pbx/new "$(NEWPBX "cli$c" "$c.e2e.invalid" "PBX $c")")"
  JID="$(echo "$R" | jget id)"; [[ -n "$JID" ]] || fail "création cli$c : $R"
  hjob "$JID" && pass "PBX cli$c créé depuis la console du serveur (formulaire, licence signée sur place)" || fail "création cli$c"
done
R="$(hapi POST /api/pbx/new "$(NEWPBX clic a.e2e.invalid "PBX c")")"
[[ "$R" == *"déjà utilisée"* ]] && pass "Adresse déjà utilisée par un autre PBX refusée" || fail "doublon accepté : $R"
[[ "$(curl -sS -b "$HJAR" "$HUB/api/pbx/clia/config" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).pbx.fqdn)}catch{console.log("")}})')" == a.e2e.invalid ]] \
  && pass "Fichier de configuration signé de cli a téléchargeable (réinstallation)" || fail "config clia"
R="$(hapi GET /api/pbx)"
[[ "$(echo "$R" | jget pbx.length)" == 2 ]] && pass "Console du serveur : 2 PBX listés" || fail "liste : $R"
[[ "$(echo "$R" | jget totals.online)" == 2 && "$(echo "$R" | jget totals.max_calls)" == 16 ]] \
  && pass "Tableau de bord : 2 PBX en ligne, 16 appels simultanés autorisés au total" || fail "tableau de bord : $(echo "$R" | jget totals | head -c 300)"
L="$(sudo /opt/pbxmaison/pbx/bin/callikoe-host liste)"; echo "$L" | sed 's/^/   /' >> "$OUT"
for c in a b; do
  sudo systemctl is-active --quiet "callikoe-asterisk@cli$c" && sudo systemctl is-active --quiet "callikoe-console@cli$c" \
    && pass "cli$c : moteur et console actifs" || { sudo journalctl -u "callikoe-asterisk@cli$c" -u "callikoe-console@cli$c" -n 20 --no-pager | cut -c1-200 >> "$OUT"; fail "services cli$c"; }
done
astx() { sudo /usr/sbin/asterisk -C "/etc/callikoe/t/$1/asterisk/asterisk.conf" -rx "$2"; }

# Isolation système : un client ne lit ni les secrets ni la base d'un autre
sudo -u cx-clia cat /etc/callikoe/t/clib/secrets.env >/dev/null 2>&1 && fail "cx-clia lit les secrets de clib" || pass "Isolation : le compte de cli a ne lit pas les secrets de cli b"
sudo -u cx-clia cat /etc/callikoe/hub/sso-key.pem >/dev/null 2>&1 && fail "cx-clia lit la clé de la console du serveur" || pass "Isolation : un PBX ne lit pas la clé de la console du serveur"
PWA="$(sudo bash -c '. /etc/callikoe/t/clia/secrets.env; echo "$DB_PASSWORD"')"
PGPASSWORD="$PWA" psql -h 127.0.0.1 -U cx_clia -d cx_clib -Atc "SELECT 1" >/dev/null 2>&1 && fail "cx_clia ouvre la base de clib" || pass "Isolation : la base de cli b refuse le compte de cli a"
PGPASSWORD="$PWA" psql -h 127.0.0.1 -U cx_clia -d callikoe_hub -Atc "SELECT 1" >/dev/null 2>&1 && fail "cx_clia ouvre la base de la console du serveur" || pass "Isolation : la base de la console du serveur refuse les PBX"
PGPASSWORD="$PWA" psql -h 127.0.0.1 -U cx_clia -d cx_clia -Atc "SELECT 1" >/dev/null 2>&1 && pass "cli a ouvre sa propre base" || fail "cx_clia n'ouvre pas sa base"
sudo -u cx-clia sudo -n /opt/pbxmaison/pbx/bin/pbx-configure --tenant clib status >/dev/null 2>&1 && fail "cx-clia agit sur clib" || pass "Isolation : la console de cli a ne peut pas configurer cli b (sudo)"

# Web : chaque adresse mène à sa console, une adresse inconnue à rien
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: a.e2e.invalid' http://127.0.0.1/api/health)" == 200 ]] && pass "Web : a.e2e.invalid → console de cli a" || fail "nginx a.e2e.invalid"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: inconnu.invalid' http://127.0.0.1/api/health)" == 404 ]] && pass "Web : adresse inconnue → 404" || fail "nginx adresse inconnue"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9001/api/setup/check -H 'content-type: application/json' -d '{}')" == 403 ]] \
  && pass "PBX client : assistant de configuration fermé (configuré par la console du serveur)" || fail "assistant ouvert sur cli a"

# 4. Ouverture de chaque PBX depuis la console du serveur (sans se reconnecter), poste 201 et trunk
declare -A PW AUTH
for c in a b; do
  n=$([[ $c == a ]] && echo 1 || echo 2); API="http://127.0.0.1:$((9000 + n))"; JAR="$LAB/jar-$c"; : > "$JAR"
  LOC="$(curl -sS -b "$HJAR" -o /dev/null -w '%{redirect_url}' "$HUB/ouvrir/cli$c")"
  [[ "$LOC" == "http://$c.e2e.invalid/api/sso?t="* ]] || fail "ouvrir cli$c : $LOC"
  TK="${LOC#*t=}"
  [[ "$(curl -sS -c "$JAR" -o /dev/null -w '%{http_code}' "$API/api/sso?t=$TK")" == 302 ]] && pass "cli$c ouvert depuis la console du serveur (sans se reconnecter)" || fail "sso cli$c"
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/sso?t=$TK")" == 403 ]] && pass "Lien d'ouverture de cli$c utilisable une seule fois" || fail "ticket réutilisable"
  [[ $c == a ]] && { [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:9002/api/sso?t=$TK")" == 403 ]] && pass "Lien d'ouverture de cli a refusé par cli b" || fail "ticket accepté par un autre PBX"; }
  capi() { curl -sS -b "$JAR" -c "$JAR" -X "$1" "$API$2" ${3:+-H "content-type: application/json" -d "$3"}; }
  R="$(capi GET /api/me)"
  [[ "$R" == *'"hub":true'* && "$R" == *'"role":"admin"'* && "$R" == *'"pbx_list":['* ]] && pass "cli$c : compte IRT administrateur, liste des PBX pour passer de l'un à l'autre" || fail "me cli$c : $R"
  R="$(capi POST /api/extensions '{"number":"201","name":"Accueil"}')"
  PW[$c]="$(echo "$R" | jget password)"; AUTH[$c]="$(echo "$R" | jget auth_id)"
  [[ -n "${PW[$c]}" && -n "${AUTH[$c]}" ]] && pass "cli$c : poste 201 créé" || fail "cli$c poste : $R"
  num=$([[ $c == a ]] && echo 0465001540 || echo 0465001550)
  R="$(capi POST /api/trunks "{\"template\":\"generique\",\"name\":\"op\",\"number\":\"$num\",\"username\":\"acct$c\",\"password\":\"pacct$c\",\"host\":\"127.0.0.50\",\"port\":5070}")"
  [[ "$R" == *'"id":"op"'* ]] && pass "cli$c : trunk « op » créé (même nom que chez l'autre client)" || fail "cli$c trunk : $R"
  [[ "$R" == *warning* ]] && echo "   $R" >> "$OUT"
  R="$(capi PUT /api/routes '{"inbound":["201"],"outbound_trunk":"op"}')"
  [[ "$R" == *'"outbound_trunk":"op"'* ]] || fail "cli$c routes : $R"
done
# Compte client de cli a (accès restreint) : invité depuis la console du PBX, ne voit que son PBX
JAR="$LAB/jar-a"
R="$(curl -sS -b "$JAR" -X POST http://127.0.0.1:9001/api/accounts -H 'content-type: application/json' -d '{"email":"client@boulangerie.invalid","name":"Client","role":"client"}')"
[[ "$R" == *invitation* || "$R" == *'"path"'* || "$R" == *'"ok":true'* ]] && pass "cli a : invitation d'un compte client (accès restreint) depuis la console du PBX" || echo "   (invitation client : $R)" >> "$OUT"
sudo cat /var/lib/callikoe/kamailio/db/tru | sed 's/^/   tru /' >> "$OUT"
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
callerid = Client <0612345678>
media_address = 127.0.0.50
bind_rtp_to_media_address = yes
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
OPNUM() { # appels sortants : le PBX présente son numéro (From), authentifié avec le compte du trunk
  cat <<EOF
[$1]
type = endpoint
context = op-in
media_address = 127.0.0.50
bind_rtp_to_media_address = yes
aors = $2
auth = $2
disallow = all
allow = ulaw,alaw
direct_media = no
EOF
}
mkast op "[global]
type = global
endpoint_identifier_order = username,ip
[transport-udp]
type = transport
protocol = udp
bind = 127.0.0.50:5070
$(OPACCT accta)
$(OPACCT acctb)
$(OPNUM 0465001540 accta)
$(OPNUM 0465001550 acctb)" "[op-in]
exten => _X.,1,Set(GLOBAL(LASTOUT)=\${CHANNEL(endpoint)}:\${EXTEN})
 same => n,Answer()
 same => n,Wait(3)
 same => n,Hangup()
[wait]
exten => s,1,Answer()
 same => n,Wait(5)
 same => n,Hangup()
[play]
exten => s,1,Answer()
 same => n,Playtones(440/300,0/200)
 same => n,Wait(6)
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
media_address = $1
bind_rtp_to_media_address = yes
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
# Capture réseau SIP (aiguilleur, PBX clients, opérateur, postes) : lue en cas d'échec
sudo rm -f /tmp/multi-sip.pcap
sudo tcpdump -i any -nn -s0 -U -w /tmp/multi-sip.pcap "udp port 5060 or udp portrange 6001-6002 or udp port 5070 or udp port 5080" >/dev/null 2>&1 &
sleep 1
# Traces SIP (lues seulement en cas d'échec)
for c in clia clib; do astx $c "logger add channel sipdebug notice,warning,error,verbose" >/dev/null; astx $c "core set verbose 3" >/dev/null; astx $c "pjsip set logger on" >/dev/null; done
sipdump() { # sipdump <PBX client> : diagnostics dans multi-diag.txt (publiés à part)
  local D="$PWD/multi-diag.txt"
  { echo "== tables de l'aiguilleur"; sudo kamcmd -s unix:/run/kamailio/kamailio_ctl htable.dump tru 2>&1 | grep -E "name|error" | head -12; sudo journalctl -t callikoe-aiguilleur --no-pager | tail -n 8
    sudo ls -la /run/kamailio 2>&1; systemctl cat kamailio 2>/dev/null | grep -E "^(Exec|User|Protect|ReadWrite|Environment)"
    sudo journalctl -u kamailio --no-pager | grep -iE "htable|db_text|dbt_|error|CALLIKOE" | grep -v reparse_on | tail -n 12 | cut -c1-220
    echo "== SIP vu par $1"
    sudo grep -E "^(REGISTER|INVITE|SIP/2.0|Route|Path|To|Contact|Supported)|Transmitting|Received" "/var/log/callikoe/$1/sipdebug" 2>/dev/null | grep -v OPTIONS | cut -c1-160 | tail -n 40
    sudo grep -E "Executing|NOTICE|WARNING" "/var/log/callikoe/$1/sipdebug" 2>/dev/null | grep -v pjsip_wizard | tail -n 15 | cut -c1-200
    sudo grep -E "WARNING|ERROR" "/var/log/callikoe/$1/messages" 2>/dev/null | grep -v pjsip_wizard | tail -n 8 | cut -c1-200
    echo "== opérateur simulé"; sudo grep -E "^(INVITE|SIP/2.0|To|Contact)|Transmitting|Received|NOTICE|WARNING" "$LAB/op/log/messages" 2>/dev/null | grep -v -E "OPTIONS|declined" | tail -n 25 | cut -c1-200
  } >> "$D" 2>&1 || true
}
labx op "core set verbose 3" >/dev/null 2>&1 || true; labx op "pjsip set logger on" >/dev/null 2>&1 || true
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
# Adresse réelle du poste (vue par l'aiguilleur) gardée par le PBX et affichée dans sa console
P="$(sudo -u postgres psql -d cx_clia -tAc "SELECT path FROM ps_contacts WHERE endpoint = '201'" 2>&1)"
R="$(curl -sS -b "$LAB/jar-a" http://127.0.0.1:9001/api/extensions)"
[[ "$P" == *"received=sip:127.0.0.11"* && "$R" == *'"source_ip":"127.0.0.11"'* ]] && pass "Console de cli a : adresse réelle du poste 201 (notée par l'aiguilleur)" || { echo "   path=$P" >> "$OUT"; echo "$R" | cut -c1-500 >> "$OUT"; fail "adresse réelle du poste"; }
sleep 8
regd px && fail "poste pirate enregistré chez cli b avec les identifiants de cli a" || pass "Poste de cli a refusé par cli b (identifiants d'un autre PBX)"
sudo journalctl -u kamailio --no-pager | grep -q "CALLIKOE-AUTHFAIL 127.0.0.13" && pass "Échec noté avec l'adresse réelle du poste pirate (fail2ban)" || { sudo journalctl -u kamailio -n 30 --no-pager | cut -c1-200 >> "$OUT"; fail "AUTHFAIL absent"; }
labx px "module unload res_pjsip_outbound_registration.so" >/dev/null 2>&1 || true
# Console du serveur › Téléphonie : l'échec y apparaît en clair, avec le PBX concerné
R="$(hapi GET '/api/telephonie?minutes=60')"
echo "$R" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.events.some(e=>e.kind==="auth"&&e.ip==="127.0.0.13"&&/poste 201/.test(e.text))?0:1)' \
  && pass "Console du serveur › Téléphonie : mot de passe refusé affiché (poste 201, adresse réelle)" || { echo "$R" | cut -c1-600 >> "$OUT"; fail "journal téléphonie"; }
# Surveillance : un événement d'un PBX remonte dans la console du serveur et se marque « vérifié »
sudo -u postgres psql -d cx_clia -qc "INSERT INTO pbxmaison_watch (key, kind, extension, text) VALUES ('e2e:1', 'intl', '201', 'Appel vers l''étranger : 0044201234 depuis le poste 201 (non abouti).')" >/dev/null 2>&1 || true
R="$(hapi GET '/api/surveillance?days=7')"
WID="$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).events.find(x=>x.pbx==="clia"&&x.kind==="intl");console.log(e?e.id:"")})')"
[[ -n "$WID" ]] && hapi POST /api/surveillance/ok "{\"pbx\":\"clia\",\"id\":\"$WID\"}" | grep -q '"ok":true' \
  && [[ "$(sudo -u postgres psql -d cx_clia -tAc "SELECT reviewed_by FROM pbxmaison_watch WHERE key = 'e2e:1'")" == irt-admin@test.invalid ]] \
  && pass "Surveillance : appel vers l'étranger de cli a affiché dans la console du serveur et marqué vérifié" || { echo "$R" | cut -c1-400 >> "$OUT"; fail "surveillance"; }
hapi POST /api/telephonie/bloquer '{"ip":"203.0.113.7"}' >/dev/null
R="$(hapi GET '/api/telephonie?minutes=15')"
if [[ "$R" == *'"ip":"203.0.113.7","jail":"callikoe-manual"'* ]]; then
  hapi POST /api/telephonie/debloquer '{"ip":"203.0.113.7"}' >/dev/null
  [[ "$(hapi GET '/api/telephonie?minutes=15')" != *'"ip":"203.0.113.7","jail"'* ]] && pass "Téléphonie : bloquer puis débloquer une adresse depuis la console du serveur" || fail "déblocage"
else echo "$R" | cut -c1-400 >> "$OUT"; fail "blocage manuel"; fi

opreg() { labx op "pjsip show contacts" | grep -q "$1/"; }
waitfor 60 opreg accta && waitfor 60 opreg acctb && pass "Trunks des deux clients enregistrés chez l'opérateur (via l'aiguilleur)" || { labx op "pjsip show contacts" >> "$OUT"; astx clia "pjsip show registrations" >> "$OUT"; sipdump clia; fail "trunks non enregistrés"; }
labx op "pjsip show contacts" | grep -qE "cx[0-9a-f]{16}" && pass "Contact du trunk = jeton propre au client" || { labx op "pjsip show contacts" >> "$OUT"; fail "contact sans jeton"; }

glob() { labx "$1" "dialplan show globals" | sed -nE "s/^\s*$2=(.*)$/\1/p" | head -n1; }
reset() { labx pa "dialplan set global RANG none" >/dev/null; labx pb "dialplan set global RANG none" >/dev/null; labx op "dialplan set global LASTOUT none" >/dev/null; }

# 5. Appels entrants : opérateur → trunk de A → poste 201 de A (et pas celui de B)
sudo timeout 9 tcpdump -i any -nn -q "udp and (portrange 10000-10399 or portrange 30000-30099 or portrange 31000-31199)" 2>/dev/null > "$LAB/rtp-all.txt" &
astx clia "rtp set debug on" >/dev/null 2>&1 || true
reset; labx op "channel originate PJSIP/accta extension s@play" >/dev/null; sleep 4
{ echo "== Pendant l'appel entrant A (PBX cli a)"; astx clia "core show channels concise"; astx clia "bridge show all"; astx clia "pjsip show channelstats"
  for ch in $(astx clia "core show channels concise" | cut -d'!' -f1); do astx clia "core show channel $ch" | grep -iE "NativeFormats|WriteFormat|ReadFormat|WriteTranscode|ReadTranscode|Bridge|State|Application|Data" ; done
  echo "== Poste pa"; labx pa "core show channels concise"; } >> "$PWD/multi-diag.txt" 2>&1 || true
sleep 5.5
astx clia "rtp set debug off" >/dev/null 2>&1 || true
[[ "$(glob pa RANG)" == 201 && "$(glob pb RANG)" == none ]] && pass "Entrant sur le trunk de cli a → poste 201 de cli a uniquement" || { echo "RANG A=$(glob pa RANG) B=$(glob pb RANG)" >> "$OUT"; sipdump clia; fail "entrant A"; }
NRTP="$(grep -cE '> [0-9.]+\.310[0-9]{2}:' "$LAB/rtp-all.txt" || true)"
{ echo "== RTP pendant l'appel entrant A (flux : nombre de paquets)"; awk '{print $5, $6, $7}' "$LAB/rtp-all.txt" | sort | uniq -c | sort -rn | head -20; } >> "$PWD/multi-diag.txt" 2>/dev/null || true
(( NRTP > 50 )) && pass "Son de l'opérateur reçu par le poste de cli a (${NRTP} paquets RTP, directs, sans passer par l'aiguilleur)" || { echo "   (RTP vers le poste A : ${NRTP} paquets ; compteur du poste : $(glob pa RTPRX))" >> "$OUT"; fail "son entrant"; }
reset; labx op "channel originate PJSIP/acctb extension s@wait" >/dev/null; sleep 9
[[ "$(glob pb RANG)" == 201 && "$(glob pa RANG)" == none ]] && pass "Entrant sur le trunk de cli b → poste 201 de cli b uniquement" || { echo "RANG A=$(glob pa RANG) B=$(glob pb RANG)" >> "$OUT"; sipdump clib; fail "entrant B"; }
# L'opérateur appelle directement la SDA de B (sans le jeton du trunk) : accepté car il vient de l'adresse de l'opérateur
reset; labx op "channel originate PJSIP/0465001550@acctb extension s@wait" >/dev/null; sleep 9
[[ "$(glob pb RANG)" == 201 && "$(glob pa RANG)" == none ]] && pass "Entrant vers la SDA de cli b depuis l'adresse de l'opérateur → poste 201 de cli b" || { echo "RANG A=$(glob pa RANG) B=$(glob pb RANG)" >> "$OUT"; sipdump clib; fail "entrant SDA B"; }
# Appel « pirate » vers la SDA de A, sans le jeton du trunk : refusé
reset; labx px "channel originate PJSIP/0465001540@pbx extension s@wait" >/dev/null 2>&1 || true; sleep 6
[[ "$(glob pa RANG)" == none ]] && pass "Appel vers la SDA de cli a sans le jeton de son trunk : refusé" || fail "appel pirate arrivé chez A"

# 6. Appels sortants : chaque poste sort par le trunk de son PBX
reset; labx pa "channel originate PJSIP/0412345678@pbx extension s@wait" >/dev/null; sleep 8
[[ "$(glob op LASTOUT)" == "0465001540:0412345678" ]] && pass "Sortant de cli a → opérateur, compte de cli a" || { echo "LASTOUT=$(glob op LASTOUT)" >> "$OUT"; sipdump clia; fail "sortant A"; }
reset; labx pb "channel originate PJSIP/0412345678@pbx extension s@wait" >/dev/null; sleep 8
[[ "$(glob op LASTOUT)" == "0465001550:0412345678" ]] && pass "Sortant de cli b → opérateur, compte de cli b" || { echo "LASTOUT=$(glob op LASTOUT)" >> "$OUT"; fail "sortant B"; }
astx clia "pjsip show endpoints" | grep -qE "Endpoint:\s+op" && ! astx clia "pjsip show endpoints" | grep -q "acctb" && pass "Le PBX de cli a ne voit que son trunk" || fail "endpoints A"

# 6b. Désactivation d'un PBX depuis la console du serveur, puis réactivation
JID="$(hapi POST /api/pbx/clib/suspendre | jget id)"; [[ -n "$JID" ]] && hjob "$JID" || fail "désactivation clib"
! sudo systemctl is-active --quiet callikoe-asterisk@clib && sleep 9 && [[ "$(hapi GET /api/pbx | jget totals.suspended)" == 1 ]] \
  && pass "cli b désactivé depuis la console du serveur (moteur arrêté, compté « désactivé »)" || fail "clib toujours actif"
reset; labx op "channel originate PJSIP/acctb extension s@wait" >/dev/null 2>&1 || true; sleep 6
[[ "$(glob pb RANG)" == none ]] && pass "PBX désactivé : plus aucun appel ne lui parvient" || fail "appel arrivé sur un PBX désactivé"
JID="$(hapi POST /api/pbx/clib/reactiver | jget id)"; [[ -n "$JID" ]] && hjob "$JID" || fail "réactivation clib"
waitfor 30 sudo systemctl is-active --quiet callikoe-asterisk@clib && waitfor 60 regd pb && pass "cli b réactivé : moteur actif, poste de nouveau enregistré" || fail "réactivation clib"

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
sleep 15; waitfor 90 opreg acctb && reset && labx op "channel originate PJSIP/acctb extension s@wait" >/dev/null && sleep 9 && [[ "$(glob pb RANG)" == 201 ]] \
  && pass "Entrant vers cli b après restauration" || { echo "RANG B=$(glob pb RANG)" >> "$OUT"; sudo cat /var/lib/callikoe/kamailio/db/tru >> "$OUT"; fail "entrant B après restauration"; }
: > "$HJAR"
T="$(hapi POST /api/login '{"email":"irt-admin@test.invalid","password":"MotDePasse2026"}' | jget ticket)"
R="$(hapi POST /api/login/totp "{\"ticket\":\"$T\",\"code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"ok":true'* ]] && pass "Compte de la console du serveur retrouvé après restauration" || fail "login console du serveur après restauration : $R"
LOC="$(curl -sS -b "$HJAR" -o /dev/null -w '%{redirect_url}' "$HUB/ouvrir/clib")"
[[ "$(curl -sS -c "$LAB/jar-b2" -o /dev/null -w '%{http_code}' "http://127.0.0.1:9002/api/sso?t=${LOC#*t=}")" == 302 ]]   && [[ "$(curl -sS -b "$LAB/jar-b2" http://127.0.0.1:9002/api/extensions)" == *'"201"'* ]] && pass "cli b restauré ouvert depuis la console du serveur (poste 201 présent)" || fail "ouverture de clib après restauration"

# 8. Console du serveur : suppression de cli b, puis restauration de sa sauvegarde de PBX comme nouveau PBX client
R="$(hapi DELETE /api/pbx/clib "{\"confirm\":\"clib\",\"code\":\"$(otp "$HTOTP")\"}")"
JID="$(echo "$R" | jget id)"; [[ -n "$JID" ]] && hjob "$JID" && pass "cli b supprimé depuis la console du serveur (code exigé)" || fail "suppression depuis la console du serveur : $R"
sudo tar -xzOf "$BK" ./tenants/clib.tar.gz > "$LAB/clib-bk.tar.gz"
R="$(curl -sS -b "$HJAR" -X POST "$HUB/api/pbx/import?slug=clib" -H 'content-type: application/octet-stream' --data-binary @"$LAB/clib-bk.tar.gz")"
JID="$(echo "$R" | jget id)"; [[ -n "$JID" ]] && hjob "$JID" && pass "Sauvegarde de cli b restaurée depuis la console du serveur" || fail "import : $R"
waitfor 30 sudo systemctl is-active --quiet callikoe-asterisk@clib && waitfor 60 regd pb && pass "cli b importé : moteur actif, poste 201 de nouveau enregistré" || fail "clib après import"

for d in op pa pb px; do labx "$d" "core stop now" >/dev/null 2>&1 || true; done
pass "Serveur multi-tenant validé"
