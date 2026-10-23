// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` -> one text with both, for the status and the action answers. */
export const join = (parts, separator = ' ') => ({
  en: parts.map((p) => p.en).join(separator),
  fr: parts.map((p) => p.fr).join(separator),
});

export const FEATURE_NAMES = {
  wateringAny: both('Watering now', 'Arrosage en cours'),
  currentZone: both('Zones watering now', 'Zones arrosées en ce moment'),
  rainDelay: both('Rain delay left', 'Report pour pluie restant'),
  standby: both('Standby', 'Veille'),
  stopAll: both('Stop all watering', "Arrêter tout l'arrosage"),
  watering: both('Watering', 'Arrosage'),
  start: both('Start watering', "Démarrer l'arrosage"),
  stop: both('Stop watering', "Arrêter l'arrosage"),
  none: both('none', 'aucune'),
};

export const T = {
  noAddress: both(
    'No Yardian controller yet: type its IP address and its access token in the configuration.',
    "Aucun programmateur Yardian pour le moment : saisissez son adresse IP et son jeton d'accès dans la configuration.",
  ),
  invalidAddress: (text) => both(`Not an address: ${text}.`, `Ce n'est pas une adresse : ${text}.`),
  token: {
    missing: both(
      'No access token: the controller cannot be read (the Yardian app shows it in the settings of the controller).',
      "Pas de jeton d'accès : le programmateur ne peut pas être lu (l'application Yardian l'affiche dans les réglages du programmateur).",
    ),
    invalid: both(
      'The access token holds characters a controller cannot take: not used.',
      "Le jeton d'accès contient des caractères qu'un programmateur ne peut pas prendre : non utilisé.",
    ),
  },
  ok: (name, zones, watering) =>
    both(
      `${name}: ${zones} zone(s)${watering ? ', watering now' : ''}.`,
      `${name} : ${zones} zone(s)${watering ? ', arrosage en cours' : ''}.`,
    ),
  failed: (reason) =>
    both(
      `The controller does not answer (${reason}).`,
      `Le programmateur ne répond pas (${reason}).`,
    ),
  restored: (seconds) =>
    both(
      `The controller answered the last read before the restart; next read within ${seconds} s.`,
      `Le programmateur avait répondu à la dernière lecture avant le redémarrage ; prochaine lecture d'ici ${seconds} s.`,
    ),
  waiting: both(
    'Waiting for the first read of the controller.',
    'En attente de la première lecture du programmateur.',
  ),
  startsOff: both(
    'Starting a zone is off ("Allow starting the zones"): the zones are only read and stopped.',
    'Le démarrage des zones est désactivé (« Autoriser le démarrage des zones ») : les zones sont seulement lues et arrêtées.',
  ),
  tokenRefused: both(
    'Access token refused by the controller: reading stopped until you save another token or the "Check the controller" button succeeds. Check the token in the Yardian app.',
    "Jeton d'accès refusé par le programmateur : lecture arrêtée jusqu'à ce que vous enregistriez un autre jeton ou que le bouton « Vérifier le programmateur » réussisse. Vérifiez le jeton dans l'application Yardian.",
  ),
  startTokenRefused: both(
    'The controller refused a start with this access token lately: starts refused for a while (stops still sent).',
    "Le programmateur a refusé un démarrage avec ce jeton d'accès il y a peu : démarrages refusés pendant un temps (les arrêts partent toujours).",
  ),
  paused: both(
    'The controller asked to wait (HTTP 429 or 5xx): reads paused for a while (stops still sent).',
    "Le programmateur a demandé d'attendre (HTTP 429 ou 5xx) : lectures en pause pendant un temps (les arrêts partent toujours).",
  ),
  notController: both(
    'The answer has no controller identity (yid, serialNumber): is it a Yardian controller?',
    "La réponse ne donne pas l'identité du programmateur (yid, serialNumber) : est-ce un programmateur Yardian ?",
  ),
  moved: (previous, next) =>
    both(
      `${previous} was at this address, ${next} answers now. Give the controller a fixed address in your router.`,
      `${previous} était à cette adresse, ${next} y répond maintenant. Donnez une adresse fixe au programmateur dans votre box.`,
    ),
  check: {
    none: both(
      'No address in the configuration: type the IP address of your controller.',
      'Aucune adresse dans la configuration : saisissez l’adresse IP de votre programmateur.',
    ),
    ok: (name, id, model, zones, age) =>
      both(
        `"${name}" (${model || 'model unknown'}, ${id}): ${zones} zone(s), read ${age} s ago.`,
        `« ${name} » (${model || 'modèle inconnu'}, ${id}) : ${zones} zone(s), lu il y a ${age} s.`,
      ),
    failed: (reason, age) =>
      both(`No answer (${reason}), ${age} s ago.`, `Pas de réponse (${reason}), il y a ${age} s.`),
    pending: both('Not read yet.', 'Pas encore lu.'),
    interval: (seconds) =>
      both(
        `(Never read sooner than every ${seconds} s.)`,
        `(Jamais lu plus souvent que toutes les ${seconds} s.)`,
      ),
  },
};

/** The command refusals and errors (one language, the configured one). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonctionnalité ne se commande pas.'),
  badValue: both('Invalid value.', 'Valeur invalide.'),
  unknownDevice: both(
    'This controller is not known, or no longer at its address: nothing sent.',
    "Programmateur inconnu, ou plus à son adresse : rien n'a été envoyé.",
  ),
  unknownZone: both(
    'This zone is not known or is disabled on the controller: nothing sent.',
    "Cette zone est inconnue ou désactivée sur le programmateur : rien n'a été envoyé.",
  ),
  startDisabled: both(
    'Starting a zone is disabled in the configuration ("Allow starting the zones"): nothing sent.',
    "Le démarrage des zones est désactivé dans la configuration (« Autoriser le démarrage des zones ») : rien n'a été envoyé.",
  ),
  noToken: both(
    'No usable access token in the configuration: nothing sent.',
    "Pas de jeton d'accès utilisable dans la configuration : rien n'a été envoyé.",
  ),
  tokenRefused: both(
    'The controller refused the access token lately: nothing sent. Check the token, then save it again.',
    "Le programmateur a refusé le jeton d'accès il y a peu : rien n'a été envoyé. Vérifiez le jeton, puis enregistrez-le à nouveau.",
  ),
  tokenRefusedNow: both(
    'The controller refused the access token: no watering started. Check the token in the Yardian app.',
    "Le programmateur a refusé le jeton d'accès : aucun arrosage démarré. Vérifiez le jeton dans l'application Yardian.",
  ),
  stopTokenRefused: both(
    'The controller refused the access token: the stop was not taken. Stop the watering from the Yardian app or the controller.',
    "Le programmateur a refusé le jeton d'accès : l'arrêt n'a pas été pris. Arrêtez l'arrosage depuis l'application Yardian ou le programmateur.",
  ),
  cancelled: both(
    'Cancelled by a stop command: nothing sent.',
    "Annulée par une commande d'arrêt : rien n'a été envoyé.",
  ),
  configChanged: both(
    'The configuration changed meanwhile: nothing sent.',
    "La configuration a changé entre-temps : rien n'a été envoyé.",
  ),
  tooSlow: both(
    'The controller did not answer in time: nothing sent.',
    "Le programmateur n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  blocked: both(
    'The controller asked to wait: nothing sent.',
    "Le programmateur a demandé d'attendre : rien n'a été envoyé.",
  ),
  unknownState: both(
    'The zones watering could not be read just now: nothing sent.',
    "Les zones en arrosage n'ont pas pu être lues à l'instant : rien n'a été envoyé.",
  ),
  justStarted: both(
    'A zone of this controller was started just now and is not read watering yet: nothing sent. Try again in a minute.',
    "Une zone de ce programmateur vient d'être démarrée et n'est pas encore lue en arrosage : rien n'a été envoyé. Réessayez dans une minute.",
  ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: (reason) =>
    both(
      `The controller refused the command (${reason}).`,
      `Le programmateur a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the zone in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la zone dans quelques secondes.`,
    ),
  notSeen: both('not read back yet', 'pas encore relue'),
  stopTasksUnknown: both(
    'The waterings running could not be read (C1 models stop them one by one): nothing sent yet. Gladys watches for a minute and sends the stop as soon as a read shows them; otherwise stop from the Yardian app.',
    "Les arrosages en cours n'ont pas pu être lus (les modèles C1 les arrêtent un par un) : rien n'a encore été envoyé. Gladys surveille pendant une minute et envoie l'arrêt dès qu'une lecture les montre ; sinon, arrêtez depuis l'application Yardian.",
  ),
};
