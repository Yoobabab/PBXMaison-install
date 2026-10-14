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
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$API$2" -H "x-setup-token: $TOKEN" -H "content-type: application/json" ${3:+-d "$3"}
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
TR="$(sudo /usr/sbin/asterisk -rx 'pjsip show transports' | awk '/^Transport:/ {print $2}' | paste -sd' ' -)"
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
R="$(api GET /api/dashboard)"
echo "$R" | grep -q '"activation_code":"PBXACT1\.' && pass "Code d'installation disponible pour le portail" || fail "code : $R"
api GET /api/calls | grep -q '"available":true' && pass "Appels en cours : lecture via AMI OK" || fail "AMI"

# 5. Réinstallation (mise à jour) sans perte de configuration
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_NO_FIREWALL=1 timeout 900 bash ../../install.sh > reinstall.out 2>&1 || { tail -n 30 reinstall.out; fail "réinstallation"; }
sleep 3
sudo /usr/sbin/asterisk -rx 'pjsip show endpoints' | grep -qE "Endpoint:\s+201(/|\s)" && pass "Mise à jour (relance de la commande) : configuration conservée" || fail "config perdue après mise à jour"
echo "OK" >> "$OUT"
