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

api() { # api <méthode> <chemin> [json]
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$API$2" -H "x-setup-token: $TOKEN" ${3:+-H "content-type: application/json" -d "$3"}
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
R="$(api POST /api/setup/admin '{"password":"MotDePasse2026"}')"
echo "$R" | grep -q '"ok":true' && pass "Assistant : compte administrateur créé" || fail "admin : $R"
curl -sS -X POST "$API/api/setup/check" -H "x-setup-token: $TOKEN" -H "content-type: application/json" -d '{"config":{}}' | grep -q "invalide" \
  && pass "Jeton d'installation désactivé après création du compte" || fail "le jeton fonctionne encore"

# 3. Moteur
sudo systemctl is-active --quiet asterisk && pass "Asterisk actif ($(sudo /usr/sbin/asterisk -V))" || fail "Asterisk arrêté"
TR="$(sudo /usr/sbin/asterisk -rx 'pjsip show transports' | awk '/^Transport:/ && $2 !~ /^</ {print $2}' | paste -sd' ' -)"
[[ "$TR" == *transport-udp* ]] && pass "Transports SIP : $TR" || fail "transports : $TR"
sudo /usr/sbin/asterisk -rx "odbc show asterisk" | grep -qi "active connections: [1-9]" && pass "Asterisk connecté à la base (ODBC)" || fail "ODBC non connecté"
sudo /usr/sbin/asterisk -rx "core show settings" | grep -i "language" | head -1 | sed 's/^ */   /' >> "$OUT" || true

# 4. Console
curl -sS -c "$JAR" -X POST "$API/api/login" -H "content-type: application/json" -d '{"email":"admin@test.invalid","password":"MotDePasse2026"}' | grep -q '"ok":true' \
  && pass "Connexion à la console" || fail "connexion"
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
echo "$CFG" | grep -q "^phone_setting.backgrounds = Config:wallpaper-800x480.png$" && [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/phone/wallpaper-800x480.png)" == 200 ]] \
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
curl -sS "http://127.0.0.1/app/provision?t=${TOK}&format=json" | grep -q '"extension":"201"' && pass "QR code appli mobile : identifiants servis (valable 48 h)" || fail "app provision"
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
if python3 webrtc.py http://127.0.0.1 204 "$PA" 205 "$PB" "" callflow 2>&1 | tee -a "$OUT" | tail -1 | grep -q "Gestion d'appels OK"; then pass "Appels réels : groupe 600 et SVI 800 (touche 1)"; else
  sudo tail -n 30 /var/log/asterisk/messages | cut -c1-220 >> "$OUT"; fail "appels gestion d'appels"; fi

R="$(api GET /api/dashboard)"
echo "$R" | grep -q '"activation_code":"PBXACT1\.' && pass "Code d'installation disponible pour le portail" || fail "code : $R"
api GET /api/calls | grep -q '"available":true' && pass "Appels en cours : lecture via AMI OK" || fail "AMI"

# 5. Réinstallation (mise à jour) sans perte de configuration
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_NO_FIREWALL=1 timeout 900 bash ../../install.sh > reinstall.out 2>&1 || { tail -n 30 reinstall.out; fail "réinstallation"; }
sleep 3
sudo /usr/sbin/asterisk -rx 'pjsip show endpoints' | grep -qE "Endpoint:\s+201(/|\s)" && pass "Mise à jour (relance de la commande) : configuration conservée" || fail "config perdue après mise à jour"
sudo /usr/sbin/asterisk -rx 'dialplan show 201@users' | grep -q "user-external,0612345678" && pass "Mise à jour : renvois conservés" || fail "renvois perdus après mise à jour"
echo "OK" >> "$OUT"
