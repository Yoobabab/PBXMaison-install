# Nouveautés de Callikoe

## 1.5.0
- Serveur multi-tenant : plusieurs PBX clients sur un seul VPS, tous en SIP 5060 (aiguilleur SIP), chacun isolé (moteur, console, base, trunk)
- Console du serveur (comme Omada) : comptes IRT avec rôles et double authentification, liste et recherche des PBX, création d'un PBX, ouverture d'un PBX sans se reconnecter et passage de l'un à l'autre
- Sauvegarde et restauration du serveur entier en une commande ; réinitialisation compatible
- Trunks avec proxy (Unyc…) : adresse du proxy correctement transmise au moteur

## 1.4.0
- Console d'administration sur son propre port HTTPS 8822 (réservable aux adresses de l'installateur) ; le 443 ne sert plus qu'au softphone, à l'appli et aux téléphones
- Yealink T57W, T48U, T77U : écran « Show More » dessiné (6 touches à gauche, 5 à droite, 3 colonnes de 6 au centre)

## 1.3.1
- Touches : modules d'extension Yealink EXP43, EXP50 et EXP55 (jusqu'à 3), écrans tactiles (T57W, T48U, T58) dessinés avec leurs raccourcis à l'écran, dessin du poste sans le clavier

## 1.3.0
- Touches du téléphone : le poste est dessiné comme sur la notice, on clique sur une touche pour choisir BLF, Statut, numérotation rapide ou ligne
- Rôles : accès complet, technicien, accès restreint (utilisateurs, téléphones, routage, annuaire) et accès visuel
- Licence : changement d'édition, d'appels simultanés ou renouvellement en collant la nouvelle clé du portail
- Capture réseau des appels (fichier pcap pour Wireshark), avec ou sans l'audio
- Modèles d'opérateurs : codecs corrigés (G.711 A-law en premier, G.722 pour Sewan et Dstny, G.729 retiré car non converti par le moteur)

## 1.2.0
- Console : double authentification obligatoire (compatible Psono), codes de secours, comptes nominatifs par technicien, journal des modifications
- Anti-fraude : plafond d'appels externes par heure et d'appels internationaux par jour, téléphones acceptés seulement depuis les réseaux autorisés
- Tableau de bord : état du système, test du pare-feu, redémarrage des services ou du serveur
- Touche « Statut » sur le téléphone : le voyant suit le statut choisi dans la console, un appui le bascule
- Utilisateurs masqués, sonneries différentes selon le type d'appel, reprovisionnement sans redémarrage
- Routage : SVI créé et modifié dans l'éditeur, messages audio importables (WAV, MP3…) pour groupes, files et SVI, horaires définis dans l'éditeur

## 1.1.0
- Règles sortantes comme 3CX : préfixe, postes, longueur, jusqu'à 5 routes de secours, numéro présenté au choix
- Sécurité : numéros bloqués, pays autorisés, surtaxés, appels masqués, limites par utilisateur, adresses IP bloquées, accès à la console par IP
- Enregistrement des appels externes (écoute et téléchargement), annonce à l'appelant, conservation réglable
- Codes raccourcis modifiables (parcage, interception, statut, files d'attente, interphone…)
- Sauvegardes locales et copie FTP / FTPS / SFTP, restauration
- Mises à jour en un clic, page Licence, alertes (préparées)
- Passerelles analogiques et bases DECT, téléphones Fanvil, Snom et Grandstream
- Nouvelle navigation de la console, éditeur de routage simplifié

## 1.0.0
- Première version : trunks, utilisateurs, téléphones Yealink, gestion d'appels, softphone, chat, vidéo, journal des appels, annuaire
