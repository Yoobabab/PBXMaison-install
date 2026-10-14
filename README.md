# PBXMaison — installation

Installe un PBX PBXMaison sur un **VPS ou un PC sous Debian 12 ou Ubuntu 24.04 (64 bits)**.

## 1. Avant de commencer

- Sur le portail : crée le PBX et télécharge son **`pbx-config.json`**.
- Chez ton hébergeur DNS : fais pointer le nom du PBX (ex. `martin.pbx.exemple.fr`) vers l'IP publique du VPS (enregistrement **A**). Sans cela, tout fonctionne mais sans certificat HTTPS ; il pourra être obtenu plus tard depuis la console.

## 2. Installation (PuTTY)

Connecte-toi au VPS en SSH et colle :

```bash
curl -fsSL https://raw.githubusercontent.com/Yoobabab/PBXMaison-install/main/install.sh | sudo bash
```

Environ 1 à 3 minutes selon le VPS. À la fin, une adresse s'affiche :

```
Ouvre cette adresse dans ton navigateur :
    http://203.0.113.10/?jeton=…
```

## 3. Assistant web

1. Dépose `pbx-config.json` : la licence et le DNS sont vérifiés.
2. « Installer ce PBX » : configuration du moteur, certificat HTTPS, démarrage.
3. Choisis le mot de passe administrateur (l'identifiant est l'e-mail saisi sur le portail).
4. Copie le **code d'installation** et colle-le dans le portail (fiche du PBX → « Enregistrer l'installation »).

Ensuite tout se règle dans la console : **Trunks** (liste des opérateurs : Dstny, NETW, Sewan, Unyc… les réglages se remplissent seuls), **Postes**, **Routes**, **Appels en cours**, **Système**.

## Mise à jour

Relancer la même commande met à jour le PBX sans toucher à sa configuration.

## Ports

| Port | Usage |
|---|---|
| UDP 5060, TCP 5060 | SIP |
| TCP 5061 | SIP TLS |
| UDP 10000–20000 | Audio |
| TCP 80, 443 | Console web, certificat |

Machine derrière une box : rediriger ces ports et désactiver le « SIP ALG ».

## Ce que contient ce dépôt

| Dossier | Rôle |
|---|---|
| `install.sh` | Installation en une commande |
| `console/` | Console web et assistant (Node.js, sans framework) |
| `pbx/` | Configuration Asterisk, modèles d'opérateurs, `pbx-configure` (actions système de la console) |
| `packaging/` | Compilation d'Asterisk 22 LTS, publiée par GitHub Actions dans la Release `latest` |
| `tests/e2e/` | Test complet sur une machine vierge à chaque modification |
