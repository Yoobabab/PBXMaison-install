#!/usr/bin/env bash
# =============================================================================
#  Compile Asterisk 22 LTS et produit une archive prête à installer.
#  Exécuté par GitHub Actions dans un conteneur Debian 12 ou Ubuntu 24.04.
#
#  Usage : build-asterisk.sh <nom-cible> <dossier-sortie>
#    ex.   build-asterisk.sh debian12 /out
#
#  Produit : asterisk-<cible>-amd64.tar.gz   (fichiers à extraire dans /)
#            asterisk-<cible>-amd64.deps     (paquets apt nécessaires à l'exécution)
# =============================================================================
set -Eeuo pipefail

TARGET="${1:?cible manquante (debian12, ubuntu2404)}"
OUT="${2:?dossier de sortie manquant}"
ASTERISK_MAJOR=22
URL="https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_MAJOR}-current.tar.gz"
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$OUT"

apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates wget build-essential file debconf-utils >/dev/null
echo "libvpb1 libvpb1/countrycode string 33" | debconf-set-selections

cd /usr/src
wget -q -O asterisk.tar.gz "$URL"
tar xzf asterisk.tar.gz
SRC="$(ls -d /usr/src/asterisk-${ASTERISK_MAJOR}.*/ | sort -V | tail -n1)"; SRC="${SRC%/}"
VERSION="$(basename "$SRC" | sed 's/^asterisk-//')"
cd "$SRC"
echo "== Asterisk $VERSION pour $TARGET"

contrib/scripts/install_prereq install >/dev/null
./configure --with-jansson-bundled --with-pjproject-bundled >/dev/null
make -s menuselect.makeopts >/dev/null
menuselect/menuselect \
  --enable res_odbc --enable res_config_odbc --enable cdr_odbc --enable cel_odbc \
  --disable BUILD_NATIVE \
  --enable CORE-SOUNDS-FR-ALAW --enable CORE-SOUNDS-FR-ULAW --enable CORE-SOUNDS-FR-G722 \
  --enable CORE-SOUNDS-EN-ALAW --enable CORE-SOUNDS-EN-ULAW \
  --enable MOH-OPSOUND-ALAW --enable MOH-OPSOUND-ULAW --enable MOH-OPSOUND-G722 \
  menuselect.makeopts
make -s -j"$(nproc)" >/dev/null

STAGE=/tmp/stage
rm -rf "$STAGE"
make -s install DESTDIR="$STAGE" >/dev/null
# Pas de fichiers de configuration d'exemple : PBXMaison écrit les siens
rm -rf "$STAGE/etc/asterisk"
# Outils de création du schéma de base (alembic) et modèles de config utiles
install -d "$STAGE/usr/share/asterisk"
cp -a contrib/ast-db-manage "$STAGE/usr/share/asterisk/ast-db-manage"
install -m 0644 configs/samples/indications.conf.sample "$STAGE/usr/share/asterisk/indications.conf.sample"
install -m 0644 configs/samples/musiconhold.conf.sample "$STAGE/usr/share/asterisk/musiconhold.conf.sample"
echo "$VERSION" > "$STAGE/usr/share/asterisk/VERSION"

# Dépendances d'exécution : bibliothèques liées → paquets apt qui les fournissent
find "$STAGE/usr/sbin" "$STAGE/usr/lib" -type f \( -name '*.so*' -o -perm -u+x \) -print0 \
  | xargs -0 file | awk -F: '/ELF/ {print $1}' \
  | xargs -r ldd 2>/dev/null | awk '/=> \// {print $3}' | sort -u \
  | while read -r lib; do dpkg -S "$(readlink -f "$lib")" 2>/dev/null || dpkg -S "$lib" 2>/dev/null || true; done \
  | cut -d: -f1 | sort -u | grep -v -E '^(libc6|libgcc-s1|libstdc\+\+6)$' > "$OUT/asterisk-${TARGET}-amd64.deps"
echo "== Dépendances : $(tr '\n' ' ' < "$OUT/asterisk-${TARGET}-amd64.deps")"

tar -C "$STAGE" -czf "$OUT/asterisk-${TARGET}-amd64.tar.gz" .
echo "$VERSION" > "$OUT/asterisk-${TARGET}-amd64.version"
ls -lh "$OUT"
