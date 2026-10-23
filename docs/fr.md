# Yardian

Intégration Gladys Assistant non officielle pour les programmateurs
d'arrosage connectés **Yardian** (Yardian, Yardian Pro, Yardian Pro C1), par
leur API HTTP **locale** : pas de cloud Yardian, pas de compte. Sans lien avec
Aeon Matrix ni Yardian.

**Jamais testé avec un vrai appareil** : construite d'après la bibliothèque du
fabricant (pyyardian 1.4.2, celle de l'intégration Home Assistant). Merci de
signaler ce qui marche et ce qui ne marche pas.

## Ce que vous obtenez

- **Le programmateur** : arrosage en cours (oui/non), les zones arrosées en
  ce moment, le report pour pluie restant (minutes), la veille, et un bouton
  **Arrêter tout l'arrosage**.
- **Chaque zone activée** : arrosage en cours (oui/non), un bouton
  **Démarrer l'arrosage** et un bouton **Arrêter l'arrosage**.

L'arrosage n'est jamais un interrupteur : un « allume/éteins tout » d'un
assistant vocal, de HomeKit ou d'une scène sur les interrupteurs ne peut
jamais ouvrir une vanne.

## Mise en route

1. Donnez au programmateur une adresse IP fixe dans votre box.
2. Trouvez son **jeton d'accès** dans l'application Yardian (réglages du
   programmateur).
3. Dans Gladys, ouvrez l'intégration, saisissez l'adresse et le jeton,
   enregistrez.
4. Ajoutez le programmateur et ses zones depuis l'onglet **Découverte**.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
seulement à votre programmateur, en clair sur votre réseau local (le
programmateur n'a pas de https).

## Démarrer et arrêter

- **Démarrer une zone ouvre une vanne : c'est désactivé par défaut.** Activez
  **Autoriser le démarrage des zones** pour utiliser les boutons Démarrer.
  Sans cela, le tableau de bord, les scènes et les assistants vocaux peuvent
  seulement lire et arrêter.
- Avant chaque démarrage, Gladys lit le programmateur : un autre programmateur
  à l'adresse, ou des zones en arrosage illisibles : refusé ; la zone déjà en
  arrosage : rien n'est envoyé. La zone arrose pendant la durée réglée (10
  minutes par défaut, **60 minutes au plus**) ; le programmateur referme seul
  la vanne à la fin.
- Après un démarrage, un autre démarrage sur le même programmateur est
  **refusé tout de suite** (« Réessayez dans une minute ») tant que la zone
  n'est pas lue en arrosage, 60 s au plus.
- **Arrêter n'est jamais bloqué** par l'option, une pause demandée par le
  programmateur, un jeton refusé ni un démarrage récent. L'arrêt est refusé,
  sans rien envoyer, seulement si : un autre programmateur répond à l'adresse ;
  le programmateur n'est plus à son adresse ; aucun jeton d'accès n'est
  saisi ; sur les modèles C1, les arrosages en cours ne peuvent pas être lus
  (Gladys surveille alors pendant une minute et envoie l'arrêt dès qu'une
  lecture les montre). Sur un C1 avec plus de 32 arrosages en cours, ou
  certains illisibles, les arrosages lisibles (32 au plus) sont arrêtés.
- Un arrêt annule les démarrages pas encore envoyés. Un démarrage déjà parti
  avant l'arrêt est surveillé aussi, pendant une minute après sa réponse
  (lectures à 5, 15, 30 et 55 s) : s'il est appliqué après l'arrêt dans
  cette minute, l'arrêt est renvoyé. Si les zones sont encore lues en
  arrosage après un arrêt, il est renvoyé (3 fois au plus, dans la minute),
  sauf si un démarrage accepté par le programmateur est parti après lui.
- Sur les Yardian et Yardian Pro sans le suffixe C1, le programmateur n'arrête
  que **toutes les zones à la fois** : le bouton Arrêter d'une zone les arrête
  toutes.
- Une commande part dans les 3,5 s ou est refusée sans être envoyée.
  « Envoyée, sans confirmation » veut dire que le programmateur l'a peut-être
  prise mais qu'elle n'a pas encore été relue : vérifiez la zone quelques
  secondes plus tard.

## Rafraîchissement

Le programmateur est lu toutes les 30 s par défaut (10 à 600 s), jamais plus
souvent : ni après un redémarrage, ni après une reconnexion, une recherche ou
le bouton Vérifier. S'il demande d'attendre (HTTP 429 ou 5xx), les lectures
font une pause d'1 minute à 6 heures. S'il refuse le jeton, les lectures
s'arrêtent jusqu'à ce que vous enregistriez un autre jeton ou que le bouton
**Vérifier le programmateur** réussisse (il réessaie une fois, jamais plus
vite que l'intervalle).

## Limites

- Un seul programmateur par intégration.
- Les modèles YC (suffixe C1) et les champs du report pour pluie et de la
  veille n'ont pas été vus sur une vraie réponse : voir TODO.md dans le dépôt.
- Un arrosage lancé par un programme du programmateur : rien ne dit que
  l'arrêt de l'API Yardian l'arrête (inconnu). Sinon, vous verrez « envoyée,
  sans confirmation », puis 3 renvois : arrêtez-le depuis l'application
  Yardian.
- Pas encore de programmes, d'actions de scène ni de widget.
