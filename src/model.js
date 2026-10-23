// -----------------------------------------------------------------------------
// Known controllers -> Gladys devices and values (pure).
//
// A known controller (a record of `devices` in /data, see src/store.js)
// becomes one controller device and one device per enabled zone. External ids
// (frozen):
//   gladys.externalIds('yardian', <id>)                   the controller
//   gladys.externalIds('yardian-zone', `<id>-<number>`)   zone <number> (1-based)
// where <id> is the yid of the controller (`sn-<serial>` without one, see
// identityOf). Feature keys (frozen):
//   controller: watering, current_zone, rain_delay, standby (read only),
//               stop (BUTTON: stops every zone)
//   zone:       watering (read only), start, stop (BUTTONS)
//
// Watering is never a switch nor a commandable binary: a "turn everything
// on/off" (voice assistants, HomeKit, scenes on switches) must never open a
// valve.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPES } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';

const binary = () => ({
  category: C.UNKNOWN,
  type: T.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
  command: true,
});

/** The features of a controller: `[{ key, spec, name }]`, in a stable order. */
export function controllerFeatures() {
  return [
    { key: 'watering', spec: binary(), name: FEATURE_NAMES.wateringAny },
    {
      key: 'current_zone',
      spec: {
        category: C.TEXT,
        type: T.TEXT.TEXT,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
        text: true,
      },
      name: FEATURE_NAMES.currentZone,
    },
    {
      key: 'rain_delay',
      spec: {
        category: C.DURATION,
        type: T.DURATION.INTEGER,
        min: 0,
        max: 525_600,
        unit: U.MINUTES,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      name: FEATURE_NAMES.rainDelay,
    },
    { key: 'standby', spec: binary(), name: FEATURE_NAMES.standby },
    { key: 'stop', spec: button(), name: FEATURE_NAMES.stopAll },
  ];
}

/** The features of a zone. */
export function zoneFeatures() {
  return [
    { key: 'watering', spec: binary(), name: FEATURE_NAMES.watering },
    { key: 'start', spec: button(), name: FEATURE_NAMES.start },
    { key: 'stop', spec: button(), name: FEATURE_NAMES.stop },
  ];
}

export const controllerIds = (gladys, record) =>
  gladys.externalIds(EXTERNAL_ID_TYPES.CONTROLLER, record.id);
export const zoneIds = (gladys, record, number) =>
  gladys.externalIds(EXTERNAL_ID_TYPES.ZONE, `${record.id}-${number}`);

export function controllerName(record) {
  return (record.name || `Yardian ${record.id.slice(-6)}`).slice(0, 100);
}

const featureOf = (ids, { key, spec, name }, language) => {
  const feature = {
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    category: spec.category,
    type: spec.type,
    min: spec.min,
    max: spec.max,
    read_only: spec.read_only,
    has_feedback: spec.has_feedback,
    keep_history: spec.keep_history,
  };
  if (spec.unit) {
    feature.unit = spec.unit;
  }
  return feature;
};

/** The controller device of a known controller. */
export function buildControllerDevice(gladys, record, { language }) {
  const ids = controllerIds(gladys, record);
  const params = [
    { name: 'IP_ADDRESS', value: record.host ?? '' },
    { name: 'MODEL', value: record.model ?? '' },
    { name: 'SERIAL_NUMBER', value: record.serial ?? '' },
    { name: 'YID', value: record.yid ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: controllerName(record),
    external_id: ids.device,
    features: controllerFeatures().map((f) => featureOf(ids, f, language)),
    params,
    should_poll: false,
  };
}

/** The device of a zone of a known controller. */
export function buildZoneDevice(gladys, record, zone, { language }) {
  const ids = zoneIds(gladys, record, zone.number);
  return {
    name: `${zone.name} (${controllerName(record)})`.slice(0, 100),
    external_id: ids.device,
    features: zoneFeatures().map((f) => featureOf(ids, f, language)),
    params: [
      { name: 'ZONE_NUMBER', value: String(zone.number) },
      { name: 'CONTROLLER', value: record.id },
    ],
    should_poll: false,
  };
}

/** The zones offered in the Discovery tab: the enabled ones. */
export const offeredZones = (record) => record.zones.filter((zone) => zone.enabled);

/**
 * featureId -> `{ state }` or `{ text }` from a reading, only the values
 * known: a missing value is skipped, never 0, never NaN.
 */
export function valuesOf(gladys, record, reading, { language }) {
  const values = new Map();
  const ids = controllerIds(gladys, record);
  const number = (key, value, featureIds = ids) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.set(featureIds.feature(key), { state: value });
    }
  };
  const active = reading.active;
  if (active) {
    number('watering', active.size > 0 ? 1 : 0);
    const names = record.zones
      .filter((zone) => active.has(zone.number - 1))
      .map((zone) => zone.name);
    const text = names.length > 0 ? names.join(', ') : word(FEATURE_NAMES.none, language);
    values.set(ids.feature('current_zone'), { text: text.slice(0, 250) });
    for (const zone of record.zones) {
      number('watering', active.has(zone.number - 1) ? 1 : 0, zoneIds(gladys, record, zone.number));
    }
  }
  number('rain_delay', reading.rainDelayMinutes);
  if (typeof reading.standby === 'boolean') {
    number('standby', reading.standby ? 1 : 0);
  }
  return values;
}
