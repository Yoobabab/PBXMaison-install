#!/usr/bin/env bash
# =============================================================================
#  Migration réelle d'un PBX installé seul vers le serveur multi-tenant (suite de run.sh) :
#  sauvegarde du PBX seul (faite par run.sh) → réinitialisation du VPS → installation multi-tenant
#  → console du serveur → « Restaurer un PBX » avec la sauvegarde → le PBX tourne comme client,
#  avec ses postes, ses trunks et ses renvois.
#    import-standalone.sh <sauvegarde-du-pbx-seul.tar.gz>
#  Ajoute ses lignes à e2e-result.txt.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")"
OUT="$PWD/e2e-result.txt"
BK="$(readlink -f "$1")"
pass() { echo "✔ $*" | tee -a "$OUT"; }
fail() { echo "✖ $*" | tee -a "$OUT"; exit 1; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")}catch{console.log("")}})' "$1"; }
LASTSTEP_FILE="$(mktemp)"; echo 0 > "$LASTSTEP_FILE"
otp() {
  local st; while :; do st=$(( $(date +%s) / 30 )); (( st > $(cat "$LASTSTEP_FILE") )) && break; sleep 2; done
  echo "$st" > "$LASTSTEP_FILE"
  node -e 'import(process.argv[1]).then((a) => console.log(a.totpCode(process.argv[2], Number(process.argv[3]))))' "$PWD/../../console/lib/auth.mjs" "$1" "$st"
}
[[ -s "$BK" ]] || fail "sauvegarde du PBX seul introuvable"
sudo tar -tzf "$BK" ./etc/pbx-config.json >/dev/null 2>&1 && pass "Migration : sauvegarde du PBX seul prête ($(du -h "$BK" | cut -f1))" || fail "sauvegarde du PBX seul illisible"

# 1. VPS remis à zéro puis serveur multi-tenant (même clé de signature que le portail de test)
sudo bash ../../reset.sh --confirmer > reset-mt.out 2>&1 || { tail -n 20 reset-mt.out >> "$OUT"; fail "réinitialisation avant multi-tenant"; }
node make-config.mjs . hub.e2e.invalid cfg-srv.json --serveur >/dev/null
IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
T0=$SECONDS
# shellcheck disable=SC2024
sudo env PBXM_REF="${PBXM_REF:-main}" PBXM_TRUSTED_KEY_FILE="$PWD/test-key.pem" PBXM_NO_FIREWALL=1 PBXM_NO_AUTOUPDATE=1 PBXM_PUBLIC_IP="$IP" \
  timeout 1200 bash ../../install.sh --multi-tenant --serveur "$(base64 -w0 cfg-srv.json)" > install-mt.out 2>&1 \
  || { grep -v -E '\.{10}' install-mt.out | tail -n 30 | cut -c1-200 >> "$OUT"; fail "installation multi-tenant après le PBX seul"; }
pass "Migration : serveur multi-tenant installé sur le même VPS en $(( SECONDS - T0 )) s"

# 2. Console du serveur : super administrateur, connexion
HUB=http://127.0.0.1:8800; HJAR="$(mktemp)"
hapi() { curl -sS -b "$HJAR" -c "$HJAR" -X "$1" "$HUB$2" ${3:+-H "content-type: application/json" -d "$3"}; }
HTOKEN="$(sudo cat /var/lib/callikoe/hub/setup-token)"
HTOTP="$(curl -sS -c "$HJAR" -X POST "$HUB/api/setup/totp" -H "x-setup-token: $HTOKEN" | jget secret)"
R="$(curl -sS -b "$HJAR" -c "$HJAR" -X POST "$HUB/api/setup/admin" -H "x-setup-token: $HTOKEN" -H "content-type: application/json" -d "{\"name\":\"IRT\",\"password\":\"MotDePasse2026\",\"totp_code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"recovery_codes":['* ]] || fail "super admin (migration) : $R"
: > "$HJAR"
T="$(hapi POST /api/login '{"email":"irt-admin@test.invalid","password":"MotDePasse2026"}' | jget ticket)"
R="$(hapi POST /api/login/totp "{\"ticket\":\"$T\",\"code\":\"$(otp "$HTOTP")\"}")"
[[ "$R" == *'"ok":true'* ]] && pass "Migration : connexion à la console du serveur" || fail "connexion (migration) : $R"

# 3. « Restaurer un PBX » avec la sauvegarde du PBX seul
R="$(curl -sS -b "$HJAR" -X POST "$HUB/api/pbx/import?slug=migre" -H 'content-type: application/octet-stream' --data-binary @"$BK")"
JID="$(echo "$R" | jget id)"; [[ -n "$JID" ]] || fail "import refusé : $R"
for _ in $(seq 1 150); do J="$(hapi GET "/api/jobs/$JID")"; [[ "$J" == *'"running":false'* ]] && break; sleep 2; done
[[ "$J" == *'"ok":true'* ]] && pass "Migration : sauvegarde du PBX seul restaurée comme PBX client « migre »" \
  || { echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of JSON.parse(s).lines||[])console.log("   "+l)})' | cut -c1-200 >> "$OUT"; fail "import du PBX seul"; }

# 4. Le PBX importé tourne avec sa configuration
for _ in $(seq 1 30); do sudo systemctl is-active --quiet callikoe-asterisk@migre && break; sleep 2; done
sudo systemctl is-active --quiet callikoe-asterisk@migre && sudo systemctl is-active --quiet callikoe-console@migre \
  && pass "Migration : moteur et console du PBX importé actifs" || { sudo journalctl -u callikoe-asterisk@migre -n 20 --no-pager | cut -c1-200 >> "$OUT"; fail "PBX importé arrêté"; }
CONF=/etc/callikoe/t/migre/asterisk/asterisk.conf
astm() { sudo /usr/sbin/asterisk -C "$CONF" -rx "$1" 2>/dev/null; }
for _ in $(seq 1 20); do astm "pjsip show endpoints" | grep -qE "Endpoint:\s+201(/|\s)" && break; sleep 2; done
astm "pjsip show endpoints" | grep -qE "Endpoint:\s+201(/|\s)" && astm "pjsip show endpoints" | grep -qE "Endpoint:\s+202(/|\s)" \
  && pass "Migration : postes 201 et 202 du PBX seul retrouvés" || { astm "pjsip show endpoints" | head -20 >> "$OUT"; fail "postes perdus à l'import"; }
astm "dialplan show 201@users" | grep -q "user-external,0612345678" && pass "Migration : renvois du poste 201 conservés" || fail "renvois perdus à l'import"
astm "pjsip show registrations" | grep -q "dstny" && pass "Migration : trunks du PBX seul retrouvés" || { astm "pjsip show registrations" >> "$OUT"; fail "trunks perdus à l'import"; }
# Le trunk passe désormais par l'aiguilleur (pas de transport propre au PBX)
trproxy() { sudo -u postgres psql -d cx_migre -tAc "SELECT outbound_proxy FROM ps_registrations WHERE id LIKE 'dstny%' LIMIT 1" 2>/dev/null | grep -q "127.0.0.2"; }
for _ in $(seq 1 20); do trproxy && break; sleep 2; done
trproxy \
  && pass "Migration : trunks repassés par l'aiguilleur du serveur" || { sudo -u postgres psql -d cx_migre -tAc "SELECT id, outbound_proxy, transport FROM ps_registrations" >> "$OUT" 2>&1; fail "trunk importé hors aiguilleur"; }
LOC="$(curl -sS -b "$HJAR" -o /dev/null -w '%{redirect_url}' "$HUB/ouvrir/migre")"
N="$(sudo sh -c '. /etc/callikoe/t/migre/tenant.env; echo $TENANT_N')"
MJAR="$(mktemp)"
[[ "$(curl -sS -c "$MJAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((9000 + N))/api/sso?t=${LOC#*t=}")" == 302 ]] \
  && [[ "$(curl -sS -b "$MJAR" "http://127.0.0.1:$((9000 + N))/api/extensions")" == *'"201"'* ]] \
  && pass "Migration : PBX importé ouvert depuis la console du serveur (poste 201 présent)" || fail "ouverture du PBX importé"
