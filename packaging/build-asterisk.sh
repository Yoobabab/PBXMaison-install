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
# Dépendances de compilation (liste explicite plutôt que contrib/scripts/install_prereq,
# qui installe aussi des paquets inutiles et télécharge des sources supplémentaires)
apt-get install -y -q --no-install-recommends \
  ca-certificates wget curl file patch bzip2 xz-utils build-essential pkg-config autoconf automake libtool python3 \
  libedit-dev libjansson-dev libxml2-dev uuid-dev libsqlite3-dev libssl-dev libncurses-dev libsrtp2-dev \
  libcurl4-openssl-dev libxslt1-dev unixodbc-dev libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev \
  libgsm1-dev liburiparser-dev libpopt-dev libopusfile-dev libsndfile1-dev

cd /usr/src
wget -q -O asterisk.tar.gz "$URL"
tar xzf asterisk.tar.gz
SRC="$(ls -d /usr/src/asterisk-${ASTERISK_MAJOR}.*/ | sort -V | tail -n1)"; SRC="${SRC%/}"
VERSION="$(basename "$SRC" | sed 's/^asterisk-//')"
cd "$SRC"
echo "== Asterisk $VERSION pour $TARGET"

echo "== configure"
./configure --with-jansson-bundled --with-pjproject-bundled 2>&1 | tail -n 25
make -s menuselect.makeopts >/dev/null
menuselect/menuselect \
  --enable res_odbc --enable res_config_odbc --enable cdr_odbc --enable cel_odbc \
  --disable BUILD_NATIVE \
  --enable CORE-SOUNDS-FR-ALAW --enable CORE-SOUNDS-FR-ULAW --enable CORE-SOUNDS-FR-G722 \
  --enable CORE-SOUNDS-EN-ALAW --enable CORE-SOUNDS-EN-ULAW \
  --enable MOH-OPSOUND-ALAW --enable MOH-OPSOUND-ULAW --enable MOH-OPSOUND-G722 \
  menuselect.makeopts
echo "== make ($(nproc) cœurs)"
make -s -j"$(nproc)" 2>&1 | grep -E -i "error|erreur" | head -n 40 || true
test -x main/asterisk || { echo "Échec de la compilation"; exit 1; }

STAGE=/tmp/stage
rm -rf "$STAGE"
echo "== make install (+ sons)"
make -s install DESTDIR="$STAGE" 2>&1 | grep -v -E '\.{10}' | tail -n 20 || true
test -x "$STAGE/usr/sbin/asterisk" || { echo "Échec de make install"; exit 1; }
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
