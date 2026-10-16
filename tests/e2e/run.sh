#!/usr/bin/env bash
# =============================================================================
#  Test de bout en bout sur une machine vierge (GitHub Actions, Ubuntu 24.04) :
#  installation en une commande → assistant (API) → console (API) → vérifications Asterisk.
#  Écrit le résultat dans e2e-result.txt (une ligne par vérification).
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"
OUT="$PWD/e2e-result.txt"; : > "$OUT"
pass() { echo "✔ $*" | tee -a "$OUT"; }
fail() { echo "✖ $*" | tee -a "$OUT"; exit 1; }
API=http://127.0.0.1:8080
JAR="$(mktemp)"

node make-config.mjs . | tee -a "$OUT"

# 1. Installation (comme sur un VPS, avec la clé de test et le code de ce commit)
T0=$SECONDS
# shellcheck disable=SC2024  # le journal appartient à l'utilisateur du test, volontairement
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_TRUSTED_KEY_FILE="$PWD/test-key.pem" PBXM_NO_FIREWALL=1 \
  timeout 900 bash ../../install.sh > install.out 2>&1 || { grep -v -E '\.{10}' install.out | tail -n 40 | cut -c1-200 >> "$OUT"; fail "install.sh a échoué ou a dépassé 15 min"; }
pass "install.sh terminé en $(( SECONDS - T0 )) s"
grep -q "jeton=" install.out && pass "URL de l'assistant affichée : $(grep -o 'http://[^ ]*jeton=[0-9a-f]*' install.out | sed 's/jeton=.*/jeton=…/')"
TOKEN="$(sudo cat /var/lib/pbxmaison/setup-token)"

# Double authentification : code TOTP calculé comme une appli (Psono…), jamais deux fois le même pas de 30 s
LASTSTEP_FILE="$(mktemp)"; echo 0 > "$LASTSTEP_FILE"; TOTP=""
otp() {
  local st; while :; do st=$(( $(date +%s) / 30 )); (( st > $(cat "$LASTSTEP_FILE") )) && break; sleep 2; done
  echo "$st" > "$LASTSTEP_FILE"
  node -e 'import(process.argv[1]).then((a) => console.log(a.totpCode(process.argv[2], Number(process.argv[3]))))' "$PWD/../../console/lib/auth.mjs" "$TOTP" "$st"
}
raw_api() { curl -sS -b "$JAR" -c "$JAR" -X "$1" "$API$2" -H "x-setup-token: $TOKEN" ${3:+-H "content-type: application/json" -d "$3"}; }
api() { # api <méthode> <chemin> [json] — redemande un code si l'action est sensible
  local r; r="$(raw_api "$@")"
  if [[ "$r" == *'"need_reauth":true'* ]]; then raw_api POST /api/reauth "{\"code\":\"$(otp)\"}" >/dev/null; r="$(raw_api "$@")"; fi
  printf '%s' "$r"
}
CFG="$(cat pbx-config.json)"

# 2. Assistant
R="$(api POST /api/setup/check "{\"config\":$CFG}")"
echo "$R" | grep -q '"ok":true' && pass "Assistant : licence acceptée" || fail "check : $R"
R="$(api POST /api/setup/check '{"config":{"version":1}}')"
echo "$R" | grep -q '"ok":false' && pass "Assistant : fichier non signé refusé" || fail "fichier non signé accepté : $R"
api POST /api/setup/apply "{\"config\":$CFG}" >/dev/null
for _ in $(seq 1 120); do
  P="$(api GET /api/setup/progress)"
  echo "$P" | grep -q '"running":false' && echo "$P" | grep -q '"ok":\(true\|false\)' && break
  sleep 2
done
echo "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s).steps)console.log(`   [${x.status}] ${x.step} : ${x.message.slice(0,140)}`)})' | tee -a "$OUT"
echo "$P" | grep -q '"ok":true' || fail "Configuration échouée"
pass "Assistant : configuration appliquée"
TOTP="$(api POST /api/setup/totp | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).secret))')"
[[ "$TOTP" =~ ^[A-Z2-7]{32}$ ]] && pass "Assistant : QR code de double authentification proposé" || fail "totp setup : $TOTP"
R="$(api POST /api/setup/admin '{"password":"MotDePasse2026","totp_code":"000000"}')"
echo "$R" | grep -q "Code incorrect" && pass "Assistant : mauvais code de double authentification refusé" || fail "code faux accepté : $R"
R="$(api POST /api/setup/admin "{\"password\":\"MotDePasse2026\",\"totp_code\":\"$(otp)\"}")"
echo "$R" | grep -q '"ok":true' && echo "$R" | grep -q '"recovery_codes":\[' && pass "Assistant : compte administrateur créé avec double authentification et codes de secours" || fail "admin : $R"
curl -sS -X POST "$API/api/setup/check" -H "x-setup-token: $TOKEN" -H "content-type: application/json" -d '{"config":{}}' | grep -q "invalide" \
  && pass "Jeton d'installation désactivé après création du compte" || fail "le jeton fonctionne encore"

# 3. Moteur
sudo systemctl is-active --quiet asterisk && pass "Asterisk actif ($(sudo /usr/sbin/asterisk -V))" || fail "Asterisk arrêté"
TR="$(sudo /usr/sbin/asterisk -rx 'pjsip show transports' | awk '/^Transport:/ && $2 !~ /^</ {print $2}' | paste -sd' ' -)"
[[ "$TR" == *transport-udp* ]] && pass "Transports SIP : $TR" || fail "transports : $TR"
sudo /usr/sbin/asterisk -rx "odbc show asterisk" | grep -qi "active connections: [1-9]" && pass "Asterisk connecté à la base (ODBC)" || fail "ODBC non connecté"
sudo /usr/sbin/asterisk -rx "core show settings" | grep -i "language" | head -1 | sed 's/^ */   /' >> "$OUT" || true

# 4. Console
: > "$JAR"
R="$(curl -sS -c "$JAR" -X POST "$API/api/login" -H "content-type: application/json" -d '{"email":"admin@test.invalid","password":"MotDePasse2026"}')"
TICKET="$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).ticket||"")}catch{console.log("")}})')"
[[ -n "$TICKET" ]] && [[ "$(raw_api GET /api/trunks)" == *"double authentification"* || "$(raw_api GET /api/trunks)" == *"Session"* ]] && pass "Connexion : le mot de passe seul ne donne pas accès à la console" || fail "connexion sans code : $R"
curl -sS -b "$JAR" -c "$JAR" -X POST "$API/api/login/totp" -H "content-type: application/json" -d "{\"ticket\":\"$TICKET\",\"code\":\"$(otp)\"}" | grep -q '"ok":true' \
  && pass "Connexion à la console (mot de passe + code de double authentification)" || fail "connexion"
raw_api GET /api/audit | grep -q "Connexion à la console" && pass "Journal d'audit : connexion notée (IP, date)" || fail "audit"
R="$(raw_api PUT /api/security '{"max_per_hour":100}')"
[[ "$R" == *'"settings"'* ]] && pass "Action sensible : acceptée sans redemander le code (session validée par la double authentification)" || fail "action sensible : $R"
R="$(api POST /api/trunks '{"template":"dstny","name":"dstny","number":"0465001530","username":"testuser","password":"testpass"}')"
echo "$R" | grep -q '"id":"dstny"' && pass "Trunk Dstny créé depuis le modèle" || fail "trunk : $R"
R="$(api POST /api/trunks '{"template":"unyc","name":"unyc","number":"0465000800","username":"10000","password":"x","host":"pbx.eqinoxe.com"}')"
echo "$R" | grep -q '"id":"unyc"' && pass "Trunk Unyc créé (proxy du modèle)" || fail "trunk unyc : $R"
R="$(api POST /api/extensions '{"number":"201","name":"Accueil"}')"
echo "$R" | grep -q '"password"' && pass "Poste 201 créé" || fail "poste : $R"
api POST /api/extensions '{"number":"202","name":"Atelier"}' >/dev/null
R="$(api PUT /api/routes '{"inbound":["201","202"],"outbound_trunk":"dstny"}')"
echo "$R" | grep -q '"outbound_trunk":"dstny"' && pass "Routes enregistrées" || fail "routes : $R"
sleep 3
EP="$(sudo /usr/sbin/asterisk -rx 'pjsip show endpoints')"
for e in 201 202 dstny unyc; do echo "$EP" | grep -qE "Endpoint:\s+$e(/|\s)" && pass "Asterisk voit l'endpoint $e" || fail "endpoint $e absent"; done
REG="$(sudo /usr/sbin/asterisk -rx 'pjsip show registrations')"
echo "$REG" | grep -q "dstny/sip:voip03.myopenip.fr" && pass "Enregistrement du trunk Dstny tenté : $(echo "$REG" | grep dstny/ | awk '{print $3}')" || fail "registration dstny absente"
sudo /usr/sbin/asterisk -rx "dialplan show 0412345678@from-internal" | grep -q "outbound" && pass "Plan de numérotation : numéro national → trunk" || fail "dialplan national"
sudo /usr/sbin/asterisk -rx "dialplan show 0044123456@from-internal" | grep -q "International" && pass "Plan de numérotation : international bloqué" || fail "dialplan international"
sudo /usr/sbin/asterisk -rx "dialplan show globals" | grep -q "OUTBOUND_TRUNK=dstny" && pass "Routes appliquées dans Asterisk (OUTBOUND_TRUNK=dstny)" || fail "globals"
# 4b. Utilisateurs : renvois, SDA, messagerie, restrictions
R="$(api PUT /api/extensions/201 '{"mobile":"0612345678","dids":["04 65 00 15 30"],"forwarding":{"timeout":15,"no_answer":{"type":"external","target":"0612345678"},"busy":{"type":"extension","target":"202"}},"options":{"ring_mobile":true},"voicemail":{"pin":"4321"}}')"
echo "$R" | grep -q '"timeout":15' && pass "Fiche utilisateur 201 : renvois, SDA, mobile enregistrés" || fail "fiche 201 : $R"
R="$(api PUT /api/extensions/202 '{"status":"away","forwarding":{"away":{"type":"extension","target":"201"}},"options":{"block_external":true}}')"
echo "$R" | grep -q '"status":"away"' && pass "Utilisateur 202 : statut Absent + appels externes interdits" || fail "fiche 202 : $R"
R="$(api DELETE /api/extensions/202)"
echo "$R" | grep -q "Attention : 201" && pass "Suppression de 202 : avertissement « 201 renvoie vers ce poste »" || fail "avertissement suppression : $R"
R="$(api PUT /api/extensions/201 '{"forwarding":{"busy":{"type":"external","target":"0044 20 1234 5678"}}}')"
echo "$R" | grep -q "international" && pass "Renvoi vers l'international refusé" || fail "international accepté : $R"
sleep 2
D="$(sudo /usr/sbin/asterisk -rx 'dialplan show 201@users')"
echo "$D" | grep -q "PJSIP/201&PJSIP/201-web&Local/0612345678@user-external/n,15" && pass "Asterisk : 201 sonne poste + softphone web + mobile 15 s" || { echo "$D" | head -20 >> "$OUT"; fail "dialplan 201"; }
echo "$D" | grep -q "user-external,0612345678" && pass "Asterisk : non-réponse de 201 → 06 12 34 56 78" || fail "renvoi non-réponse 201"
echo "$D" | grep -q "Goto(users,202,1)" && pass "Asterisk : occupé/non connecté → poste 202" || fail "renvoi occupé 201"
sudo /usr/sbin/asterisk -rx 'dialplan show 202@users' | grep -q "Goto(users,201,1)" && pass "Asterisk : 202 absent → 201" || fail "202 absent"
sudo /usr/sbin/asterisk -rx 'dialplan show 0465001530@did-map' | grep -q "users,201" && pass "Asterisk : SDA 04 65 00 15 30 → 201" || fail "did-map"
VM="$(sudo /usr/sbin/asterisk -rx 'voicemail show users')"
echo "$VM" | grep -q "201" && pass "Messagerie vocale : boîtes créées ($(echo "$VM" | grep -c '^default'))" || { echo "$VM" | head >> "$OUT"; fail "voicemail"; }
# (pjsip show endpoint n'affiche pas set_var : lecture dans la table realtime)
[[ "$(sudo -u postgres psql -At asterisk -c "SELECT set_var FROM ps_endpoints WHERE id = '202'")" == "USER_OPTS=,1" ]] \
  && pass "Asterisk : 202 marqué « appels externes interdits »" || fail "set_var 202"
sudo /usr/sbin/asterisk -rx 'dialplan show *97@from-internal' | grep -q "vm-access" && pass "*97 : accès à sa messagerie" || fail "*97"
sudo grep -q "^INBOUND_TARGET = PJSIP/201&PJSIP/201-web$" /var/lib/pbxmaison/extensions_routes.conf && pass "Route entrante : 202 (absent) retiré de la sonnerie" || { sudo cat /var/lib/pbxmaison/extensions_routes.conf >> "$OUT"; fail "INBOUND_TARGET"; }
sudo grep -E "ERROR|WARNING" /var/log/asterisk/messages | grep -iE "pbx_config|extensions|app_voicemail|voicemail\.conf" | tail -5 > ast-err.txt || true
if [[ -s ast-err.txt ]]; then cat ast-err.txt >> "$OUT"; fail "Erreurs Asterisk au chargement du plan de numérotation"; else pass "Aucune erreur Asterisk au chargement du plan de numérotation"; fi

# 4c. Téléphones : provisioning Yealink, BLF, duplication, SDA du trunk, QR code
R="$(api PUT /api/extensions/201 '{"phone":{"model":"yealink-t57w","mac":"44:DB:D2:29:FA:7B","settings":{"led":"both","transfer":"blind"},"keys":[{"type":"line"},{"type":"blf","value":"202"}]}}')"
echo "$R" | grep -q '"mac":"44dbd229fa7b"' && pass "Téléphone Yealink T57W associé au poste 201" || fail "phone 201 : $R"
PURL="$(api GET /api/phone-options | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).provisioning_url))')"
PPATH="/${PURL#*://*/}"
CFG="$(curl -sS "http://127.0.0.1${PPATH}44dbd229fa7b.cfg")"
echo "$CFG" | grep -q "^account.1.user_name = 201$" && echo "$CFG" | grep -q "^linekey.2.type = 16$" && echo "$CFG" | grep -q "^transfer.dsskey_deal_type = 2$" \
  && pass "Provisioning : 44dbd229fa7b.cfg servi par Nginx (compte, BLF, transfert aveugle)" || { echo "$CFG" | head -20 >> "$OUT"; fail "fichier de provisioning"; }
echo "$CFG" | grep -q "^phone_setting.backgrounds = Config:callikoe-v3-800x480.png$" && [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/phone/callikoe-v3-800x480.png)" == 200 ]] \
  && pass "Provisioning : fond d'écran Callikoe (800x480) poussé et servi" || fail "fond d'écran"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1${PPATH}000000000000.cfg")" == 404 ]] && pass "Provisioning : MAC inconnue refusée (404)" || fail "MAC inconnue servie"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/prov/mauvaisjeton/44dbd229fa7b.cfg")" == 404 ]] && pass "Provisioning : mauvais jeton refusé" || fail "jeton non vérifié"
sleep 2
sudo /usr/sbin/asterisk -rx 'core show hints' | grep -q "201@users-hints" && pass "BLF : supervision des postes (hints) active" || { sudo /usr/sbin/asterisk -rx 'core show hints' | head >> "$OUT"; fail "hints"; }
sudo /usr/sbin/asterisk -rx 'dialplan show **202@from-internal' | grep -q "Pickup" && pass "Interception **202" || fail "pickup"
R="$(api POST /api/extensions '{"number":"203","first_name":"Copie","copy_from":"201"}')"
echo "$R" | grep -q '"auth_id"' && pass "Utilisateur 203 dupliqué depuis 201 (nouveaux identifiants)" || fail "duplication : $R"
api GET /api/extensions/203 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).user.phone.keys.some((k)=>k.type==="blf"&&k.value==="202")?0:1))' && pass "Duplication : touches BLF et réglages copiés" || fail "duplication touches"
R="$(api PUT /api/trunks/dstny '{"template":"dstny","number":"0465001530","username":"testuser","dids":"04 65 00 15 30\n04 65 00 15 40 - 04 65 00 15 49"}')"
api GET /api/trunks | grep -q '"0465001549"' && pass "SDA du trunk : tranche de 10 numéros enregistrée" || fail "SDA trunk : $R"
TOK="$(api POST /api/extensions/201/app-token | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"
PROV="$(curl -sS "http://127.0.0.1/app/provision?t=${TOK}&format=json")"
echo "$PROV" | grep -q '"extension":"201"' && pass "QR code appli mobile : identifiants servis (valable 48 h)" || fail "app provision"
DEV="$(echo "$PROV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).device_token||""))')"
AJ="$(mktemp)"
[[ "$(curl -sS -c "$AJ" -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1/app/login?d=$DEV")" == "302 "*"/softphone?app=1" ]] \
  && curl -sS -b "$AJ" http://127.0.0.1/api/u/me | grep -q '"201"' && pass "Appli mobile : le téléphone ouvre le softphone du poste 201 sans mot de passe (jeton d'appareil)" || fail "app login"
curl -sS -X POST http://127.0.0.1/app/logout -H 'content-type: application/json' -d "{\"device_token\":\"$DEV\"}" >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1/app/login?d=$DEV")" == 401 ]] && pass "Appli mobile : téléphone déconnecté → jeton refusé" || fail "app logout"
curl -sS "http://127.0.0.1/app/provision?t=${TOK}" | grep -q "callikoe://provision" && pass "Lien du QR code ouvert sans l'appli : page « Ouvrir dans l'application »" || fail "page appli"
# Mail de bienvenue (sélection multiple) : lien pour choisir son mot de passe du softphone
WL="$(api POST /api/extensions/bulk/welcome '{"ids":["201","202"]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).results;console.log(r.length===2&&r[0].body.includes("201")?r[0].link:"")})')"
WT="${WL##*bienvenue=}"
[[ -n "$WL" ]] && curl -sS "http://127.0.0.1/api/u/welcome/$WT" | grep -q '"extension":"201"' && pass "Mail de bienvenue préparé pour 2 utilisateurs sélectionnés (lien personnel)" || fail "bienvenue : $WL"
WJ="$(mktemp)"
curl -sS -c "$WJ" -X POST "http://127.0.0.1/api/u/welcome/$WT" -H 'content-type: application/json' -d '{"password":"Bienvenue2026"}' | grep -q '"ok":true' \
  && curl -sS -b "$WJ" http://127.0.0.1/api/u/me | grep -q '"201"' && [[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1/api/u/welcome/$WT")" == 404 ]] \
  && pass "Bienvenue : mot de passe choisi par l'utilisateur, softphone ouvert, lien utilisable une seule fois" || fail "bienvenue mot de passe"
api GET /api/phones | grep -q '"phones":\[' && pass "Menu Téléphones : liste disponible" || fail "api phones"

systemctl is-enabled --quiet pbxmaison-dns.timer && pass "Mise à jour automatique de l'adresse (timer) active" || fail "timer DNS"
sudo /opt/pbxmaison/pbx/bin/pbx-configure dns | grep -q "non gérée" && pass "Adresse personnalisée : pas d'appel au service DNS Callikoe" || fail "pbx-configure dns"

# 4d. Softphone web (lot 2) : WebSocket, endpoints WebRTC, espace utilisateur, incarnation, appel réel entre navigateurs
sudo /usr/sbin/asterisk -rx 'pjsip show transports' | grep -q "transport-wss" && pass "Transport WebSocket (WebRTC) actif" || fail "transport wss"
sudo /usr/sbin/asterisk -rx 'pjsip show endpoint 201-web' | grep -qiE "webrtc\s*:\s*(true|yes)" && pass "Endpoint WebRTC 201-web créé automatiquement" || { sudo /usr/sbin/asterisk -rx 'pjsip show endpoint 201-web' | head -5 >> "$OUT"; fail "endpoint 201-web"; }
C="$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: sip' http://127.0.0.1/ws)"
[[ "$C" == 101 ]] && pass "Nginx → Asterisk : WebSocket SIP ouvert (/ws)" || fail "WebSocket /ws : HTTP $C"
api POST /api/extensions '{"number":"204","first_name":"Web","last_name":"Un"}' >/dev/null
api POST /api/extensions '{"number":"205","first_name":"Web","last_name":"Deux"}' >/dev/null
PA="$(api POST /api/extensions/204/web-password | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).password))')"
PB="$(api POST /api/extensions/205/web-password | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).password))')"
UJ="$(mktemp)"
curl -sS -c "$UJ" -X POST "$API/api/u/login" -H 'content-type: application/json' -d "{\"login\":\"204\",\"password\":\"$PA\"}" | grep -q '"ok":true' && pass "Espace utilisateur : connexion du poste 204" || fail "login utilisateur"
curl -sS -b "$UJ" "$API/api/u/me" | grep -q '"user":"204-web"' && pass "Espace utilisateur : identifiants WebRTC fournis" || fail "api/u/me"
api POST /api/extensions/205/impersonate | grep -q '"/softphone"' && pass "Incarnation de 205 depuis la console" || fail "incarnation"
sudo /usr/sbin/asterisk -rx 'dialplan show 205@users' | grep -q "PJSIP/205&PJSIP/205-web" && pass "Appel vers 205 : sonne le poste et le softphone web" || fail "dialplan web"
api POST /api/extensions '{"number":"206","first_name":"Boîte","last_name":"Vocale"}' >/dev/null
PV="$(api POST /api/extensions/206/web-password | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).password))')"
if python3 webrtc.py http://127.0.0.1 204 "$PA" 205 "$PB" 206 2>&1 | tee -a "$OUT" | tail -1 | grep -q "Raccroché"; then pass "Appel WebRTC réel entre deux navigateurs"; else
  sudo tail -n 30 /var/log/asterisk/messages | cut -c1-220 >> "$OUT"; fail "appel WebRTC"; fi
# Messagerie vocale dans le softphone : liste, écoute, lu, suppression (console membre du groupe asterisk)
VJ="$(mktemp)"
curl -sS -c "$VJ" -X POST "$API/api/u/login" -H 'content-type: application/json' -d "{\"login\":\"206\",\"password\":\"$PV\"}" >/dev/null
VM="$(curl -sS -b "$VJ" "$API/api/u/voicemail")"
MID="$(echo "$VM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).messages||[];console.log(m[0]?.id||"")})')"
[[ "$MID" == INBOX/* ]] && pass "Messagerie vocale : message de 204 visible dans le softphone de 206" || { echo "$VM" >> "$OUT"; sudo ls -laR /var/spool/asterisk/voicemail/default 2>&1 | tail -12 >> "$OUT"; sudo grep -iE "voicemail|206" /var/log/asterisk/messages | tail -n 15 | cut -c1-200 >> "$OUT"; fail "liste messagerie"; }
C="$(curl -sS -b "$VJ" -o /tmp/vm.wav -w '%{http_code} %{content_type}' "$API/api/u/voicemail/$MID/audio")"
[[ "$C" == "200 audio/wav"* && $(stat -c %s /tmp/vm.wav) -gt 10000 ]] && pass "Messagerie vocale : écoute du message dans le navigateur" || fail "écoute messagerie : $C"
R="$(curl -sS -m 20 -b "$VJ" -X POST "$API/api/u/voicemail/$MID/read" || true)"
NID="$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch{console.log("")}})')"
NEWC="$(sudo /usr/sbin/asterisk -rx 'voicemail show users' | awk '$1=="default" && $2=="206"{print $NF}')"
[[ "$NID" == Old/* && "$NEWC" == 0 ]] && pass "Messagerie vocale : message marqué comme écouté (voyant du poste à jour)" || { echo "réponse : $R / nouveaux : $NEWC" >> "$OUT"; sudo ls -laR /var/spool/asterisk/voicemail/default/206 >> "$OUT" 2>&1; sudo journalctl -u pbxmaison-console -n 15 --no-pager | cut -c1-250 >> "$OUT"; fail "lu"; }
curl -sS -b "$VJ" -X DELETE "$API/api/u/voicemail/$NID" | grep -q '"ok":true' && [[ "$(curl -sS -b "$VJ" "$API/api/u/voicemail")" == *'"messages":[]'* ]] && pass "Messagerie vocale : suppression" || fail "suppression message"
R="$(curl -sS -b "$VJ" -X PUT "$API/api/u/settings" -H 'content-type: application/json' -d '{"status":"away","forwarding":{"away":{"type":"extension","target":"204"}}}')"
echo "$R" | grep -q '"target":"204"' && sudo /usr/sbin/asterisk -rx 'dialplan show 206@users' | grep -q "Goto(users,204" && pass "Réglages utilisateur : statut et renvoi modifiés depuis le softphone" || { echo "$R" | cut -c1-300 >> "$OUT"; sudo /usr/sbin/asterisk -rx 'dialplan show 206@users' | head -12 >> "$OUT"; fail "réglages softphone"; }

# 4e. Gestion d'appels (lot 3) : annonce, groupe, file, SVI, messagerie de groupe, horaires, règle entrante, traceur
jid() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch{console.log("")}})'; }
python3 -c "
import wave,struct,math,base64,io,json
b=io.BytesIO(); w=wave.open(b,'w'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
w.writeframes(b''.join(struct.pack('<h',int(6000*math.sin(i/4))) for i in range(12000))); w.close()
json.dump({'name':'Accueil','wav':base64.b64encode(b.getvalue()).decode()},open('prompt.json','w'))"
PID="$(api POST /api/prompts "$(cat prompt.json)" | jid)"
[[ -n "$PID" ]] && sudo -u asterisk test -r "/var/lib/pbxmaison/sounds/$(sudo ls /var/lib/pbxmaison/sounds | grep "^$PID" | head -1)" && pass "Annonce : WAV 8 kHz enregistré et lisible par Asterisk" || fail "annonce"
R="$(api POST /api/callflow/group '{"name":"Accueil","number":"600","members":["205","206"],"ring_time":15,"no_answer":{"type":"groupvm_placeholder"}}')"
echo "$R" | grep -q "Destination inconnue" && pass "Groupe : destination invalide refusée" || fail "validation groupe : $R"
VID="$(api POST /api/callflow/groupvm '{"name":"Accueil","number":"900","members":["204","205"]}' | jid)"
GID="$(api POST /api/callflow/group "{\"name\":\"Accueil\",\"number\":\"600\",\"members\":[\"205\",\"206\"],\"ring_time\":15,\"cid_prefix\":\"[Acc]\",\"no_answer\":{\"type\":\"groupvm\",\"target\":\"$VID\",\"prompt\":\"$PID\"}}" | jid)"
RID="$(api POST /api/callflow/group '{"name":"Tour","number":"601","strategy":"rotate","members":["204","205","206"]}' | jid)"
QID="$(api POST /api/callflow/queue "{\"name\":\"Support\",\"number\":\"700\",\"members\":[\"205\"],\"max_wait\":60,\"moh\":\"$PID\",\"periodic\":[\"$PID\"],\"announce_holdtime\":true,\"no_answer\":{\"type\":\"user_vm\",\"target\":\"205\"}}" | jid)"
SID="$(api POST /api/callflow/schedule '{"name":"Bureau","override":"open"}' | jid)"
IID="$(api POST /api/callflow/ivr "{\"name\":\"Standard\",\"number\":\"800\",\"prompt\":\"$PID\",\"options\":{\"1\":{\"type\":\"group\",\"target\":\"$GID\"},\"2\":{\"type\":\"queue\",\"target\":\"$QID\"}},\"invalid\":{\"type\":\"group\",\"target\":\"$GID\"},\"schedule\":\"$SID\",\"closed\":{\"type\":\"prompt\",\"target\":\"$PID\"}}" | jid)"
R="$(api POST /api/callflow/rule "{\"name\":\"Standard\",\"dids\":\"04 65 00 15 40\",\"schedule\":\"$SID\",\"open\":{\"type\":\"ivr\",\"target\":\"$IID\"},\"closed\":{\"type\":\"prompt\",\"target\":\"$PID\"}}")"
[[ -n "$GID" && -n "$RID" && -n "$QID" && -n "$IID" && "$R" == *'"kind":"rule"'* ]] && pass "Gestion d'appels : groupe, groupe cyclique, file, SVI, messagerie de groupe, horaires et règle créés" || fail "création objets : $R"
api POST /api/callflow/group '{"name":"X","number":"204"}' | grep -q "déjà utilisé" && pass "Numéro déjà pris par un utilisateur refusé" || fail "unicité numéro"
sleep 1
sudo /usr/sbin/asterisk -rx 'dialplan show 600@callflow' | grep -q 'Dial(PJSIP/205&PJSIP/205-web,15' && sudo /usr/sbin/asterisk -rx 'dialplan show 600@callflow' | grep -q 'CALLERID(name)=\[Acc\]' && pass "Asterisk : groupe 600 (sonne tous, 206 absent exclu, préfixe [Acc])" || { sudo /usr/sbin/asterisk -rx 'dialplan show 600@callflow' | head -20 >> "$OUT"; fail "groupe 600"; }
sudo /usr/sbin/asterisk -rx 'dialplan show 601@callflow' | grep -q 'GLOBAL(RR_601)' && pass "Asterisk : groupe 601 (1 à 1 en tournant)" || fail "groupe cyclique"
sudo /usr/sbin/asterisk -rx 'dialplan show ivr-800' | grep -q "Background(/var/lib/pbxmaison/sounds/$PID" && pass "Asterisk : SVI 800 avec annonce et touches" || { sudo /usr/sbin/asterisk -rx 'dialplan show ivr-800' | head -20 >> "$OUT"; fail "SVI"; }
sudo /usr/sbin/asterisk -rx 'dialplan show 0465001540@did-rules' | grep -q "rule-" && pass "Asterisk : SDA 04 65 00 15 40 → règle entrante" || fail "did-rules"
sudo /usr/sbin/asterisk -rx 'queue show q700' | grep -q "Local/205@queue-ring" && pass "Asterisk : file d'attente 700 avec son agent" || { sudo /usr/sbin/asterisk -rx 'queue show q700' >> "$OUT"; fail "file 700"; }
sudo /usr/sbin/asterisk -rx 'moh show classes' | grep -q "Class: q700" && pass "Musique d'attente personnalisée de la file" || { sudo /usr/sbin/asterisk -rx 'moh show classes' >> "$OUT"; fail "moh"; }
sudo /usr/sbin/asterisk -rx 'voicemail show users' | grep -qE "^default +900 " && pass "Messagerie de groupe 900 créée" || fail "groupvm"
sudo /usr/sbin/asterisk -rx 'pjsip show endpoint 204' | grep -q "900@default" && pass "Voyant de la messagerie de groupe chez ses membres" || fail "mailboxes groupe"
api GET "/api/trace?n=0465001540" | grep -q '"SVI 800 · Standard"' && pass "Traceur : SDA → règle → SVI → groupe" || fail "traceur"
api GET /api/forwards | grep -q '"forwards":\[' && pass "Où sont les renvois : liste disponible" || fail "renvois"
sudo grep -E "ERROR|WARNING" /var/log/asterisk/messages | grep -iE "pbx_config|extensions|app_queue|queues\.conf|res_musiconhold" | tail -5 > ast-err2.txt || true
if [[ -s ast-err2.txt ]]; then cat ast-err2.txt >> "$OUT"; fail "Erreurs Asterisk (gestion d'appels)"; else pass "Aucune erreur Asterisk au chargement de la gestion d'appels"; fi
# Routage décrit en texte → proposition → validation (éditeur visuel)
P="$(api POST /api/callflow-parse '{"text":"Quand on appelle le 04 65 00 15 41 : poste 205 sonne 20 s puis groupe Accueil puis la messagerie de groupe"}')"
echo "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const o=r.proposal.branches.open;process.exit(r.proposal.dids[0]==="0465001541"&&o.length===3&&o[0].type==="ring"&&o[0].users[0]==="205"&&o[0].time===20&&o[1].type==="group"&&o[2].type==="groupvm"?0:1)})' && pass "Routage décrit en texte : SDA, sonnerie 20 s, groupe, messagerie de groupe compris" || { echo "$P" | cut -c1-400 >> "$OUT"; fail "analyse du texte"; }
FL="$(echo "$P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).proposal;console.log(JSON.stringify({...p,name:"Routage test"}))})')"
FID="$(api POST /api/callflow/flow "$FL" | jid)"
sleep 1
sudo /usr/sbin/asterisk -rx 'dialplan show 0465001541@did-rules' | grep -q "flow-$FID" && sudo /usr/sbin/asterisk -rx "dialplan show s@flow-$FID" | grep -q 'Dial(PJSIP/205&PJSIP/205-web,20' && pass "Routage validé : SDA → étapes appliquées dans Asterisk" || { sudo /usr/sbin/asterisk -rx "dialplan show s@flow-$FID" | head -15 >> "$OUT"; fail "routage flow"; }
api GET "/api/trace?n=0465001541" | grep -q 'Routage test' && pass "Traceur : SDA → routage visuel" || fail "traceur routage"
if python3 webrtc.py http://127.0.0.1 204 "$PA" 205 "$PB" "" callflow 2>&1 | tee -a "$OUT" | tail -1 | grep -q "Gestion d'appels OK"; then pass "Appels réels : groupe 600 et SVI 800 (touche 1)"; else
  sudo tail -n 30 /var/log/asterisk/messages | cut -c1-220 >> "$OUT"; fail "appels gestion d'appels"; fi

# Vidéo : appel vidéo entre deux softphones, puis réunion vidéo (salle 500, ConfBridge SFU)
api POST /api/callflow/conf '{"name":"Réunion équipe","number":"500","max_members":10,"video":true}' | grep -q '"number":"500"' && pass "Salle de réunion 500 créée" || fail "salle de réunion"
sudo /usr/sbin/asterisk -rx 'pjsip show endpoint 204-web' | grep -iE "^\s*allow\s*:" | grep -qi "vp8" && pass "Softphone web : vidéo VP8 autorisée" || { sudo /usr/sbin/asterisk -rx 'pjsip show endpoint 204-web' | grep -iE "allow|video" >> "$OUT"; fail "codecs vidéo"; }
if python3 webrtc.py http://127.0.0.1 204 "$PA" 205 "$PB" "" video 2>&1 | tee -a "$OUT" | tail -1 | grep -q "Vidéo OK"; then pass "Appel vidéo et réunion vidéo réels entre navigateurs"; else
  sudo tail -n 40 /var/log/asterisk/messages | cut -c1-220 >> "$OUT"; fail "vidéo"; fi

# Journal des appels (CDR dans PostgreSQL)
sudo /usr/sbin/asterisk -rx 'cdr show status' | grep -qi "Adaptive ODBC" && pass "Journal des appels : enregistrement dans PostgreSQL actif" || { sudo /usr/sbin/asterisk -rx 'cdr show status' >> "$OUT"; fail "cdr status"; }
sleep 2
C="$(api GET '/api/cdr?days=1&direction=internal&status=answered')"
echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).calls;process.exit(c.some(x=>x.from.ext==="204"&&x.answered_by==="205"&&x.talk>0)?0:1)})' && pass "Journal : appel 204 → 205 répondu, durée de conversation" || { echo "$C" | cut -c1-500 >> "$OUT"; sudo -u postgres psql -d asterisk -c "select calldate,src,dst,channel,dstchannel,disposition,billsec,linkedid from cdr order by id desc limit 8" >> "$OUT" 2>&1; fail "journal cdr"; }
api GET '/api/cdr?days=1' | grep -q '"rang":\["205"' && pass "Journal : appels vers le groupe / SVI (qui a sonné)" || fail "journal groupe"
curl -sS -b "$UJ" "$API/api/u/calls" | grep -q '"direction":"out"' && pass "Softphone : historique des appels lu depuis le PBX" || fail "historique softphone"
api GET '/api/cdr.csv?days=1' | head -1 | grep -q "Répondu par" && pass "Journal : export CSV" || fail "csv"

# Annuaire de l'entreprise
api POST /api/contacts '{"first_name":"Jean","last_name":"Dupont","company":"Boulangerie Dupont","phones":[{"type":"work","number":"04 78 12 34 56"}]}' | grep -q '"0478123456"' && pass "Annuaire : contact créé" || fail "contact"
R="$(api POST /api/contacts/import '{"csv":"Prénom;Nom;Société;Téléphone;Mobile\nClaire;Bernard;Cabinet Bernard;04 72 00 11 22;\nX;Y;;abc;\n"}')"
echo "$R" | grep -q '"imported":1' && echo "$R" | grep -q '"line":3' && pass "Annuaire : import CSV (ligne invalide signalée)" || fail "import csv : $R"
sleep 1
sudo /usr/sbin/asterisk -rx 'dialplan show 0478123456@phonebook' | grep -q "CALLERID(name)=Jean Dupont Boulangerie Dupont" && pass "Annuaire : nom de l'appelant affiché sur les appels entrants" || fail "phonebook dialplan"
curl -sS "http://127.0.0.1${PPATH}phonebook.xml" | grep -q "<Name>Claire Bernard (Cabinet Bernard)</Name>" && pass "Annuaire : carnet distant Yealink servi par Nginx" || fail "phonebook.xml"
curl -sS -b "$UJ" "$API/api/u/contacts" | grep -q "Boulangerie Dupont" && pass "Softphone : annuaire de l'entreprise visible" || fail "contacts softphone"
# Utilisateur masqué et groupes de visibilité
api PUT /api/extensions/206 '{"options":{"hidden":true}}' >/dev/null
curl -sS -b "$UJ" "$API/api/u/team" | grep -q '"id":"206"' && fail "utilisateur masqué visible" || pass "Utilisateur masqué : absent de l'équipe du softphone"
curl -sS "http://127.0.0.1${PPATH}phonebook-204.xml" | grep -q "<Telephone>206</Telephone>" && fail "masqué dans l'annuaire du téléphone" || pass "Utilisateur masqué : absent de l'annuaire du téléphone"
api GET /api/extensions | grep '"id":"206"' >/dev/null && pass "Utilisateur masqué : toujours visible dans la console admin" || fail "masqué absent de la console admin"
api PUT /api/extensions/206 '{"options":{"hidden":false}}' >/dev/null
# Sonnerie selon le type d'appel
sudo /usr/sbin/asterisk -rx 'dialplan show s@pickup-mark' | grep -q "info=callikoe-" && pass "Sonneries : type d'appel envoyé au téléphone (Alert-Info)" || fail "alert-info"
api PUT /api/extensions/201 '{"phone":{"settings":{"rings":{"externe":"3"}}}}' >/dev/null
curl -sS "http://127.0.0.1${PPATH}44dbd229fa7b.cfg" | grep -q "^distinctive_ring_tones.alert_info.2.ringer = 3$" && pass "Sonneries : sonnerie 3 pour les appels externes sur le Yealink de 201" || fail "sonnerie externe"
# Comptes nominatifs (invitation d'un technicien, double authentification, rôles)
LINK="$(api POST /api/accounts '{"email":"tech@test.invalid","name":"Jean Tech","role":"lecture"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).link)}catch{console.log("")}})')"
ITOK="${LINK##*/}"
[[ -n "$ITOK" && "$ITOK" != "$LINK" ]] && pass "Comptes : lien d'invitation créé" || fail "invitation : $LINK"
ISEC="$(curl -sS "$API/api/invite/$ITOK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).secret))')"
TJAR="$(mktemp)"
ICODE="$(node -e 'import(process.argv[1]).then((a) => console.log(a.totpCode(process.argv[2], Math.floor(Date.now() / 30000))))' "$PWD/../../console/lib/auth.mjs" "$ISEC")"
curl -sS -c "$TJAR" -X POST "$API/api/invite/$ITOK" -H "content-type: application/json" -d "{\"password\":\"TechPass2026\",\"totp_code\":\"$ICODE\"}" | grep -q '"recovery_codes"' && pass "Comptes : le technicien active son compte (mot de passe + double authentification)" || fail "activation invitation"
curl -sS -b "$TJAR" "$API/api/trunks" | grep -q '"id":"dstny"' && curl -sS -b "$TJAR" -X PUT "$API/api/routes" -H "content-type: application/json" -d '{"inbound":[]}' | grep -q "lecture seule" \
  && pass "Comptes : rôle « lecture seule » consulte sans pouvoir modifier" || fail "rôle lecture seule"
raw_api GET /api/audit | grep -q "tech@test.invalid" && pass "Journal : les actions sont attribuées à chaque compte" || fail "audit par compte"
api PUT /api/accounts/tech%40test.invalid '{"role":"client"}' >/dev/null
curl -sS -b "$TJAR" -X PUT "$API/api/extensions/206" -H "content-type: application/json" -d '{"options":{"hidden":false}}' | grep '"id":"206"' >/dev/null \
  && curl -sS -b "$TJAR" "$API/api/security" | grep -q "Accès restreint" \
  && curl -sS -b "$TJAR" -X DELETE "$API/api/trunks/dstny" | grep -q "Accès restreint" \
  && pass "Comptes : accès restreint modifie les utilisateurs mais pas la sécurité ni les trunks" || fail "rôle accès restreint"
api DELETE /api/accounts/tech%40test.invalid >/dev/null
curl -sS -b "$TJAR" "$API/api/trunks" | grep -q "n'existe plus" && pass "Comptes : compte supprimé, accès coupé immédiatement" || fail "suppression de compte"


# Chat entre collègues : envoi par 204, réception en temps réel par 205 (SSE à travers Nginx)
J5="$(mktemp)"
curl -sS -c "$J5" -X POST "$API/api/u/login" -H 'content-type: application/json' -d "{\"login\":\"205\",\"password\":\"$PB\"}" >/dev/null
( timeout 12 curl -sSN -b "$J5" http://127.0.0.1/api/u/events > sse.txt 2>&1 & )
sleep 2
CID="$(curl -sS -b "$UJ" -X POST "$API/api/u/chats" -H 'content-type: application/json' -d '{"members":["205"]}' | jid)"
curl -sS -b "$UJ" -X POST "$API/api/u/chats/$CID/messages" -H 'content-type: application/json' -d '{"body":"Bonjour 205 !"}' | grep -q '"sender":"204"' && pass "Chat : message envoyé par 204" || fail "chat envoi"
sleep 2
grep -q "Bonjour 205" sse.txt && pass "Chat : reçu en temps réel par 205 (à travers Nginx)" || { head -c 400 sse.txt >> "$OUT"; fail "chat temps réel"; }
curl -sS -b "$J5" "$API/api/u/chats" | grep -q '"unread":1' && pass "Chat : message non lu compté" || fail "chat non lu"

# Règles sortantes, sécurité, codes raccourcis, enregistrement (plan de numérotation généré)
R="$(api POST /api/outbound '{"name":"Mobiles","prefixes":"06,07","lengths":"10","routes":[{"trunk":"dstny","cid_mode":"custom","cid":"04 65 00 15 31"},{"trunk":"unyc","cid_mode":"hidden"}]}')"
echo "$R" | grep -q '"summary":"numéros commençant par 06, 07, de 10 chiffres"' && pass "Règle sortante créée (2 routes, numéro présenté)" || fail "règle sortante : $R"
sleep 1
D="$(sudo /usr/sbin/asterisk -rx 'dialplan show out-rules')"
echo "$D" | grep -q "PJSIP/\${D}@unyc" && echo "$D" | grep -q "CHANUNAVAIL" && pass "Règle sortante : route de secours dans le plan de numérotation" || { echo "$D" | head -30 >> "$OUT"; fail "out-rules"; }
# Appel réel à travers la règle : le numéro composé doit arriver au trunk (variables du plan de numérotation)
sudo /usr/sbin/asterisk -rx "channel originate Local/0612345678@outbound application Wait 1" >/dev/null 2>&1 || true
sleep 6
LD="$(sudo -u postgres psql -d asterisk -tAc "select lastdata from cdr where dst='0612345678' and lastapp='Dial' order by id desc limit 1")"
[[ "$LD" == PJSIP/0612345678@dstny* || "$LD" == PJSIP/0612345678@unyc* ]] && pass "Règle sortante : le numéro composé part bien au trunk ($LD)" || { echo "lastdata : $LD" >> "$OUT"; fail "numéro composé perdu dans la règle sortante"; }
R="$(api PUT /api/security '{"intl":["32","41"],"in_block":[{"number":"0899*"},{"number":"0612000000","label":"Démarcheur"}],"out_block":["0144556677"],"max_user_calls":3}')"
echo "$R" | grep -q '"intl":\["32","41"\]' && pass "Sécurité : pays autorisés et numéros bloqués enregistrés" || fail "sécurité : $R"
sleep 1
sudo /usr/sbin/asterisk -rx 'dialplan show intl-allowed' | grep -q "_0041\." && sudo /usr/sbin/asterisk -rx 'dialplan show blocked-in' | grep -q "_0899\." && pass "Sécurité : contextes de blocage chargés dans Asterisk" || fail "contextes sécurité"
sudo /usr/sbin/asterisk -rx 'dialplan show globals' | grep -q 'SEC_MAX_USER_CALLS=3' && pass "Sécurité : limite d'appels par utilisateur appliquée" || { sudo /usr/sbin/asterisk -rx 'dialplan show globals' | grep SEC_ >> "$OUT"; fail "globals sécurité"; }
# Anti-fraude : plafond d'appels externes par heure, renvois limités au national, postes SIP limités à des réseaux
api PUT /api/security '{"max_per_hour":2}' >/dev/null; sleep 1
sudo /usr/sbin/asterisk -rx "database deltree callikoe_rate" >/dev/null 2>&1 || true
for _ in 1 2 3; do sudo /usr/sbin/asterisk -rx "channel originate Local/0612345678@outbound application Wait 1" >/dev/null 2>&1 || true; sleep 2; done
sleep 3
sudo /usr/sbin/asterisk -rx "database show callikoe_fraud" | grep -q "0612345678" && pass "Anti-fraude : au-delà du plafond par heure, l'appel est refusé" || { sudo /usr/sbin/asterisk -rx "database show callikoe_rate" >> "$OUT"; fail "plafond anti-fraude"; }
api PUT /api/security '{"max_per_hour":100}' >/dev/null
sudo /usr/sbin/asterisk -rx "dialplan show user-external" | grep -q "_0\[1-9\]XXXXXXXX" && pass "Renvois externes : seuls les numéros nationaux sont composables" || fail "renvois externes"
api PUT /api/security '{"sip_allow":["10.200.0.0/16"]}' >/dev/null; sleep 1
ACL="$(sudo -u postgres psql -d asterisk -tAc "select deny||' '||permit from ps_endpoints where id='201'")"
[[ "$ACL" == "0.0.0.0/0.0.0.0 127.0.0.1/32,10.200.0.0/16" ]] && sudo /usr/sbin/asterisk -rx "pjsip show endpoint 201" | grep -q "Endpoint:" && pass "Postes SIP limités aux réseaux autorisés (201 : $ACL)" || { echo "acl : $ACL" >> "$OUT"; fail "restriction des postes SIP"; }
api PUT /api/security '{"sip_allow":[]}' >/dev/null
F="$(api GET /api/security)"
if echo "$F" | grep -q '"f2b":{"ok":true'; then
  api POST /api/security/ban '{"ip":"203.0.113.250"}' | grep -q '"203.0.113.250"' && pass "Sécurité : adresse IP bloquée à la main (fail2ban)" || fail "ban ip"
  api POST /api/security/unban '{"ip":"203.0.113.250"}' | grep -vq '"203.0.113.250"' && pass "Sécurité : adresse IP débloquée" || fail "unban ip"
else echo "  (fail2ban indisponible sur cette machine de test : $(echo "$F" | grep -o '"f2b":{[^}]*}'))" | tee -a "$OUT"; fi
sudo /usr/sbin/asterisk -rx 'dialplan show *0@shortcodes' | grep -q "Park(default)" && sudo /usr/sbin/asterisk -rx 'dialplan show **201@from-internal' | grep -q "Pickup" && pass "Codes raccourcis : parcage *0 et interception **201" || fail "codes raccourcis"
sudo /usr/sbin/asterisk -rx 'parking show default' | grep -q "701-709" && pass "Parcage : places 701 à 709" || { sudo /usr/sbin/asterisk -rx 'parking show' >> "$OUT"; fail "parcage"; }
sudo /usr/sbin/asterisk -rx 'database put callikoe_status 204 away' >/dev/null
sleep 7
api GET /api/extensions/204 | grep -q '"status":"away"' && pass "Code *31 : statut « absent » appliqué par la console" || fail "statut par code"
sudo /usr/sbin/asterisk -rx 'devstate list' | grep "dnd204" | grep -q "INUSE" && pass "Touche Statut : voyant allumé sur le téléphone (statut absent)" || { sudo /usr/sbin/asterisk -rx 'devstate list' | grep dnd >> "$OUT"; fail "voyant statut"; }
sudo /usr/sbin/asterisk -rx 'dialplan show status204@from-internal' | grep -q "DEVICE_STATE(Custom:dnd" && pass "Touche Statut : appui = bascule du statut" || fail "bascule statut"
api PUT /api/extensions/204 '{"status":"available"}' >/dev/null
sleep 2
sudo /usr/sbin/asterisk -rx 'devstate list' | grep "dnd204" | grep -q "NOT_INUSE" && pass "Statut changé dans la console : voyant éteint sur le téléphone" || { sudo /usr/sbin/asterisk -rx 'devstate list' | grep dnd >> "$OUT"; fail "voyant statut console"; }
sudo /usr/sbin/asterisk -rx 'dialplan show s@rec-start' | grep -q "MixMonitor" && sudo /usr/sbin/asterisk -rx 'dialplan show globals' | grep -q "REC_ENABLED=1" && pass "Enregistrement des appels externes actif par défaut" || fail "enregistrement"
api GET /api/recordings | grep -q '"recordings":\[' && pass "Enregistrements : liste lisible" || fail "liste enregistrements"

# Passerelle Grandstream HT802 : provisioning par adresse MAC
api POST /api/gateways '{"model":"gs-ht802","name":"Fax","mac":"00:0B:82:AA:BB:CC","ports":[{"port":1,"user":"206"}]}' | grep -q '"model_label":"Grandstream HT802"' && pass "Passerelle HT802 créée (port 1 → 206)" || fail "passerelle"
curl -sS "http://127.0.0.1${PPATH}cfg000b82aabbcc.xml" | grep -q "<P35>206</P35>" && pass "Passerelle : fichier de provisioning Grandstream servi" || fail "provisioning HT802"

# Sauvegarde locale (base + fichiers), licence, mises à jour, alertes
api POST /api/backups/run '{}' >/dev/null
for _ in $(seq 1 30); do sleep 2; api GET /api/backups | grep -q '"running":false' && break; done
BK="$(api GET /api/backups)"
FILE="$(echo "$BK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.last&&j.last.ok?j.last.file:"")})')"
[[ -n "$FILE" ]] && sudo cp "/var/lib/pbxmaison/backups/$FILE" "$PWD/standalone-bk.tar.gz" && sudo chown "$(id -u)" "$PWD/standalone-bk.tar.gz"
[[ -n "$FILE" ]] && sudo tar -xzOf "/var/lib/pbxmaison/backups/$FILE" ./database.sql | grep "pbxmaison_settings" >/dev/null && pass "Sauvegarde : archive créée avec la base de données ($FILE)" || { echo "$BK" | grep -o '"last":{[^}]*}' >> "$OUT"; sudo ls -la /var/lib/pbxmaison/backups >> "$OUT" 2>&1; fail "sauvegarde"; }
R="$(api GET /api/system)"
echo "$R" | grep -q '"services":\[' && echo "$R" | grep -q '"cdr":{' && pass "Tableau de bord : état du système (services, sauvegarde, stockage, journal)" || fail "système : $(echo "$R" | cut -c1-200)"
R="$(api POST /api/system/firewall-check)"
echo "$R" | grep -q '"label":"SIP (UDP 5060)","proto":"udp","port":"5060","listening":true' && pass "Test du pare-feu : SIP UDP 5060 à l'écoute" || fail "test pare-feu : $(echo "$R" | cut -c1-300)"
api GET /api/license | grep -q '"key":"' && pass "Licence : informations lisibles" || fail "licence"
R="$(api POST /api/license "{\"token\":\"$(cat license-token.txt)\"}")"
[[ "$R" == *'"edition":"enterprise"'* && "$R" == *'"max_calls":8'* ]] && sudo /usr/sbin/asterisk -rx 'dialplan show globals' | grep -q "MAX_CALLS=8" \
  && pass "Licence : nouvelle clé du portail appliquée (Pro 4 → Entreprise 8 appels, moteur à jour)" || fail "changement de licence : $R"
api POST /api/license '{"token":"CLK1.abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"}' | grep -q "illisible" && pass "Licence : clé falsifiée refusée" || fail "clé falsifiée"
api POST /api/capture/start '{"seconds":5,"mode":"sip"}' | grep -q '"ok":true' && pass "Capture réseau : démarrée (5 s, SIP)" || fail "capture start"
sleep 9
CAPF="$(api GET /api/capture | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).files.find(x=>x.ready);console.log(f?f.name:"")})')"
[[ -n "$CAPF" ]] && curl -sS -b "$JAR" "$API/api/capture/file/$CAPF" -o cap.pcap && [[ "$(od -An -tx1 -N4 cap.pcap | tr -d ' ')" =~ ^(d4c3b2a1|a1b2c3d4|4d3cb2a1|0a0d0d0a)$ ]] \
  && pass "Capture réseau : fichier pcap téléchargeable (Wireshark)" || fail "capture pcap : $CAPF $(od -An -tx1 -N4 cap.pcap 2>/dev/null)"
api GET /api/updates/status | grep -q '"running":' && pass "Mises à jour : état lisible (pbx-configure)" || fail "état mise à jour"
api POST /api/alerts/check '{}' | grep -q '"sending_enabled":false' && pass "Alertes : surveillance active (envoi des e-mails en préparation)" || fail "alertes"

R="$(api GET /api/dashboard)"
echo "$R" | grep -q '"activation_code":"PBXACT1\.' && pass "Code d'installation disponible pour le portail" || fail "code : $R"
api GET /api/calls | grep -q '"available":true' && pass "Appels en cours : lecture via AMI OK" || fail "AMI"

# 5. Réinstallation (mise à jour) sans perte de configuration
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_NO_FIREWALL=1 timeout 900 bash ../../install.sh > reinstall.out 2>&1 || { tail -n 30 reinstall.out; fail "réinstallation"; }
sleep 3
sudo /usr/sbin/asterisk -rx 'pjsip show endpoints' | grep -qE "Endpoint:\s+201(/|\s)" && pass "Mise à jour (relance de la commande) : configuration conservée" || fail "config perdue après mise à jour"
sudo /usr/sbin/asterisk -rx 'dialplan show 201@users' | grep -q "user-external,0612345678" && pass "Mise à jour : renvois conservés" || fail "renvois perdus après mise à jour"

# 6. Réinitialisation du serveur puis réinstallation sur serveur propre
sudo bash ../../reset.sh > reset.out 2>&1 && fail "réinitialisation sans --confirmer acceptée" || true
sudo bash ../../reset.sh --confirmer > reset.out 2>&1 || { tail -n 20 reset.out >> "$OUT"; fail "réinitialisation"; }
[[ ! -d /opt/pbxmaison && ! -d /etc/pbxmaison && ! -d /var/lib/pbxmaison ]] && ! systemctl is-active --quiet asterisk \
  && [[ -z "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='asterisk'" 2>/dev/null)" ]] && pass "Réinitialisation : serveur nettoyé (fichiers, services, base)" || fail "réinitialisation incomplète"
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_NO_FIREWALL=1 timeout 900 bash ../../install.sh > reinstall2.out 2>&1 || { tail -n 30 reinstall2.out >> "$OUT"; fail "installation après réinitialisation"; }
for _ in $(seq 1 15); do curl -sS http://127.0.0.1/api/state 2>/dev/null | grep -q '"configured"' && break; sleep 2; done
ST="$(curl -sS http://127.0.0.1/api/state || true)"
echo "$ST" | grep -q '"configured":false' && [[ -f /usr/share/asterisk/VERSION ]] && /usr/sbin/asterisk -V | grep -q Asterisk && pass "Réinstallation sur serveur propre : assistant prêt" || { echo "état : $ST" >> "$OUT"; tail -n 8 reinstall2.out >> "$OUT"; fail "réinstallation après reset"; }
# 7. Migration : la sauvegarde du PBX seul devient un PBX client d'un serveur multi-tenant installé sur le même VPS
bash ./import-standalone.sh "$PWD/standalone-bk.tar.gz"
echo "OK" >> "$OUT"
