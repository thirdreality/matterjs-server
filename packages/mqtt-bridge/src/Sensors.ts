/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import {
    AirQuality,
    BooleanState,
    CarbonDioxideConcentrationMeasurement,
    CarbonMonoxideConcentrationMeasurement,
    Descriptor,
    ElectricalEnergyMeasurement,
    ElectricalPowerMeasurement,
    FlowMeasurement,
    FormaldehydeConcentrationMeasurement,
    IlluminanceMeasurement,
    NitrogenDioxideConcentrationMeasurement,
    OccupancySensing,
    OzoneConcentrationMeasurement,
    Pm10ConcentrationMeasurement,
    Pm1ConcentrationMeasurement,
    Pm25ConcentrationMeasurement,
    PowerSource,
    PressureMeasurement,
    RadonConcentrationMeasurement,
    RelativeHumidityMeasurement,
    SmokeCoAlarm,
    SoilMeasurement,
    Switch,
    TemperatureMeasurement,
    TotalVolatileOrganicCompoundsConcentrationMeasurement,
} from "@matter/main/clusters";

/** How a sensor property is announced to Home Assistant. */
export interface SensorEntity {
    component: "sensor" | "binary_sensor";
    name: string;
    device_class?: string;
    unit_of_measurement?: string;
    state_class?: "measurement" | "total_increasing";
    entity_category?: "diagnostic";
    /** binary_sensor: the state value meaning `on` (and its opposite meaning `off`). */
    payload_on?: boolean;
    /** sensor with device class `enum`. */
    options?: readonly string[];
}

/** A read-only zigbee2mqtt state property backed by Matter attributes. */
export interface SensorProperty {
    /** zigbee2mqtt property name, before any `_<endpoint>` suffix. */
    key: string;
    /** `<cluster>/<attribute>` paths whose changes require a re-publish. */
    paths: readonly string[];
    /** Whether the endpoint offers the property, from capabilities rather than the current value. */
    present(attributes: AttributesData, endpoint: number): boolean;
    /** The current value, undefined while unknown. */
    read(attributes: AttributesData, endpoint: number): unknown;
    entity(attributes: AttributesData, endpoint: number): SensorEntity;
}

const round = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

function raw(attributes: AttributesData, endpoint: number, cluster: number, attribute: number): unknown {
    return attributes[`${endpoint}/${cluster}/${attribute}`];
}

/** Numeric attribute value; int64 attributes may arrive as bigint, `null` means unknown. */
function numberAt(attributes: AttributesData, endpoint: number, cluster: number, attribute: number) {
    const value = raw(attributes, endpoint, cluster, attribute);
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }
    return undefined;
}

function hasAttribute(attributes: AttributesData, endpoint: number, cluster: number, attribute: number): boolean {
    return raw(attributes, endpoint, cluster, attribute) !== undefined;
}

/** A struct field from the attribute cache, which keys structs by TLV tag (`"0"`) or field name. */
function structField(value: unknown, tag: number, name: string): unknown {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    return record[String(tag)] ?? record[name];
}

function enumValue(names: readonly string[], value: unknown): string | undefined {
    return typeof value === "number" ? names[value] : undefined;
}

/** A property read straight from one numeric attribute and scaled. */
function measurement(
    key: string,
    cluster: number,
    attribute: number,
    convert: (value: number) => number,
    entity: SensorEntity,
): SensorProperty {
    return {
        key,
        paths: [`${cluster}/${attribute}`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, cluster, attribute),
        read: (attributes, endpoint) => {
            const value = numberAt(attributes, endpoint, cluster, attribute);
            return value === undefined ? undefined : convert(value);
        },
        entity: () => entity,
    };
}

/** A boolean property derived from one attribute. */
function flag(
    key: string,
    cluster: number,
    attribute: number,
    convert: (value: unknown) => boolean | undefined,
    entity: Omit<SensorEntity, "component" | "payload_on">,
): SensorProperty {
    return {
        key,
        paths: [`${cluster}/${attribute}`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, cluster, attribute),
        read: (attributes, endpoint) => convert(raw(attributes, endpoint, cluster, attribute)),
        entity: () => ({ component: "binary_sensor", payload_on: true, ...entity }),
    };
}

/** An enum property published as its zigbee2mqtt-style member name. */
function enumeration(
    key: string,
    cluster: number,
    attribute: number,
    names: readonly string[],
    entity: Omit<SensorEntity, "component" | "device_class" | "options">,
): SensorProperty {
    return {
        key,
        paths: [`${cluster}/${attribute}`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, cluster, attribute),
        read: (attributes, endpoint) => enumValue(names, raw(attributes, endpoint, cluster, attribute)),
        entity: () => ({ component: "sensor", device_class: "enum", options: names, ...entity }),
    };
}

// BooleanState carries no meaning of its own: the endpoint's device type decides what it reports, and
// only contact sensors are inverted in Home Assistant (true = closed, while the door class's on = open).

const DESCRIPTOR = Descriptor.Cluster.id;
const BOOLEAN_STATE = BooleanState.Cluster.id;

const BOOLEAN_STATE_DEVICE_TYPES = {
    contact: 0x0015, // ContactSensor
    water_leak: 0x0043, // WaterLeakDetector
    rain: 0x0044, // RainSensor
    water_freeze: 0x0041, // WaterFreezeDetector
} as const;

type BooleanStateKey = keyof typeof BOOLEAN_STATE_DEVICE_TYPES;

function deviceTypesOf(attributes: AttributesData, endpoint: number): number[] {
    const list = raw(attributes, endpoint, DESCRIPTOR, 0);
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map(entry => Number(structField(entry, 0, "deviceType"))).filter(Number.isFinite);
}

/** The property an endpoint's BooleanState is published as; `contact` when no known device type names it. */
export function booleanStateKeyOf(attributes: AttributesData, endpoint: number): BooleanStateKey {
    const deviceTypes = deviceTypesOf(attributes, endpoint);
    for (const [key, deviceType] of Object.entries(BOOLEAN_STATE_DEVICE_TYPES)) {
        if (deviceTypes.includes(deviceType)) {
            return key as BooleanStateKey;
        }
    }
    return "contact";
}

function booleanState(key: BooleanStateKey, name: string, deviceClass: string, payloadOn: boolean): SensorProperty {
    return {
        key,
        paths: [`${BOOLEAN_STATE}/0`],
        present: (attributes, endpoint) =>
            hasAttribute(attributes, endpoint, BOOLEAN_STATE, 0) && booleanStateKeyOf(attributes, endpoint) === key,
        read: (attributes, endpoint) => {
            const value = raw(attributes, endpoint, BOOLEAN_STATE, 0);
            return typeof value === "boolean" ? value : undefined;
        },
        entity: () => ({ component: "binary_sensor", name, device_class: deviceClass, payload_on: payloadOn }),
    };
}

// Concentration measurement clusters share one layout. The device names its unit; values are converted
// to the zigbee2mqtt unit within the same dimension only (ppm↔ppb, mg/m³↔µg/m³): crossing dimensions
// needs the gas's molar mass. A unit in another dimension is published as is, without a device class,
// since Home Assistant rejects a device class with a unit it does not accept for it.

const CONCENTRATION_MEASURED_VALUE = 0;
const CONCENTRATION_MEASUREMENT_UNIT = 8;
const CONCENTRATION_LEVEL_VALUE = 10;

type Dimension = "parts" | "mass" | "particles" | "radioactivity";

/** MeasurementUnitEnum → dimension and factor to the dimension's base (ppm, µg/m³, p/m³, Bq/m³). */
const MEASUREMENT_UNITS: Record<number, { dimension: Dimension; factor: number; unit: string }> = {
    0: { dimension: "parts", factor: 1, unit: "ppm" },
    1: { dimension: "parts", factor: 1e-3, unit: "ppb" },
    2: { dimension: "parts", factor: 1e-6, unit: "ppt" },
    3: { dimension: "mass", factor: 1e3, unit: "mg/m³" },
    4: { dimension: "mass", factor: 1, unit: "µg/m³" },
    5: { dimension: "mass", factor: 1e-3, unit: "ng/m³" },
    6: { dimension: "particles", factor: 1, unit: "p/m³" },
    7: { dimension: "radioactivity", factor: 1, unit: "Bq/m³" },
};

/** The unit a dimension is published in (as a factor to the dimension's base) and its HA device class. */
interface PublishedUnit {
    factor: number;
    unit: string;
    deviceClass?: string;
}

const PPM: PublishedUnit = { factor: 1, unit: "ppm" };
const PPB: PublishedUnit = { factor: 1e-3, unit: "ppb" };
const UG_M3: PublishedUnit = { factor: 1, unit: "µg/m³" };
const MG_M3: PublishedUnit = { factor: 1e3, unit: "mg/m³" };

const LEVEL_NAMES = ["unknown", "low", "medium", "high", "critical"] as const;

function concentration(
    key: string,
    name: string,
    cluster: number,
    defaultUnit: number,
    units: Partial<Record<Dimension, PublishedUnit>>,
): SensorProperty[] {
    const sourceUnit = (attributes: AttributesData, endpoint: number) => {
        const unit = numberAt(attributes, endpoint, cluster, CONCENTRATION_MEASUREMENT_UNIT);
        return MEASUREMENT_UNITS[unit ?? defaultUnit] ?? MEASUREMENT_UNITS[defaultUnit];
    };
    const publishedUnit = (attributes: AttributesData, endpoint: number): PublishedUnit => {
        const source = sourceUnit(attributes, endpoint);
        return units[source.dimension] ?? { factor: source.factor, unit: source.unit };
    };
    return [
        {
            key,
            paths: [`${cluster}/${CONCENTRATION_MEASURED_VALUE}`, `${cluster}/${CONCENTRATION_MEASUREMENT_UNIT}`],
            present: (attributes, endpoint) =>
                hasAttribute(attributes, endpoint, cluster, CONCENTRATION_MEASURED_VALUE),
            read: (attributes, endpoint) => {
                const value = numberAt(attributes, endpoint, cluster, CONCENTRATION_MEASURED_VALUE);
                if (value === undefined) {
                    return undefined;
                }
                const source = sourceUnit(attributes, endpoint);
                return round((value * source.factor) / publishedUnit(attributes, endpoint).factor, 3);
            },
            entity: (attributes, endpoint) => {
                const unit = publishedUnit(attributes, endpoint);
                return {
                    component: "sensor",
                    name,
                    unit_of_measurement: unit.unit,
                    state_class: "measurement",
                    ...(unit.deviceClass === undefined ? {} : { device_class: unit.deviceClass }),
                };
            },
        },
        enumeration(`${key}_level`, cluster, CONCENTRATION_LEVEL_VALUE, LEVEL_NAMES, { name: `${name} level` }),
    ];
}

const SMOKE_CO = SmokeCoAlarm.Cluster.id;
const ALARM_ACTIVE = (value: unknown) => (typeof value === "number" ? value !== 0 : undefined);
const ALARM_STATE_NAMES = ["normal", "warning", "critical"] as const;

const ELECTRICAL_POWER = ElectricalPowerMeasurement.Cluster.id;
const ELECTRICAL_ENERGY = ElectricalEnergyMeasurement.Cluster.id;

/** First of several attributes that carries a number (e.g. Voltage, falling back to RmsVoltage). */
function electrical(
    key: string,
    attributeIds: readonly number[],
    convert: (value: number) => number,
    entity: SensorEntity,
): SensorProperty {
    const first = (attributes: AttributesData, endpoint: number) =>
        attributeIds.find(id => hasAttribute(attributes, endpoint, ELECTRICAL_POWER, id));
    return {
        key,
        paths: attributeIds.map(id => `${ELECTRICAL_POWER}/${id}`),
        present: (attributes, endpoint) => first(attributes, endpoint) !== undefined,
        read: (attributes, endpoint) => {
            for (const id of attributeIds) {
                const value = numberAt(attributes, endpoint, ELECTRICAL_POWER, id);
                if (value !== undefined) {
                    return convert(value);
                }
            }
            return undefined;
        },
        entity: () => entity,
    };
}

/** Cumulative energy (EnergyMeasurementStruct, energy in mWh) in kWh. */
function energy(key: string, attribute: number, name: string): SensorProperty {
    return {
        key,
        paths: [`${ELECTRICAL_ENERGY}/${attribute}`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, ELECTRICAL_ENERGY, attribute),
        read: (attributes, endpoint) => {
            const mWh = structField(raw(attributes, endpoint, ELECTRICAL_ENERGY, attribute), 0, "energy");
            if (typeof mWh !== "number" && typeof mWh !== "bigint") {
                return undefined;
            }
            return round(Number(mWh) / 1e6, 3);
        },
        entity: () => ({
            component: "sensor",
            name,
            device_class: "energy",
            unit_of_measurement: "kWh",
            state_class: "total_increasing",
        }),
    };
}

/**
 * Read-only properties an endpoint can contribute, in Home Assistant entity order. A property whose key
 * several endpoints provide gets the zigbee2mqtt `_<endpoint>` suffix.
 */
export const ENDPOINT_SENSORS: readonly SensorProperty[] = [
    {
        key: "occupancy",
        paths: [`${OccupancySensing.Cluster.id}/0`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, OccupancySensing.Cluster.id, 0),
        read: (attributes, endpoint) => {
            const value = raw(attributes, endpoint, OccupancySensing.Cluster.id, 0);
            if (typeof value === "number") {
                return (value & 1) !== 0;
            }
            if (typeof value === "object" && value !== null) {
                return (value as { occupied?: boolean }).occupied === true;
            }
            return undefined;
        },
        entity: () => ({ component: "binary_sensor", name: "Occupancy", device_class: "motion", payload_on: true }),
    },
    booleanState("contact", "Contact", "door", false),
    booleanState("water_leak", "Water leak", "moisture", true),
    booleanState("rain", "Rain", "moisture", true),
    booleanState("water_freeze", "Water freeze", "cold", true),
    {
        key: "illuminance",
        paths: [`${IlluminanceMeasurement.Cluster.id}/0`],
        present: (attributes, endpoint) => hasAttribute(attributes, endpoint, IlluminanceMeasurement.Cluster.id, 0),
        // Matter and Zigbee share the encoding: MeasuredValue = 10000*log10(lux) + 1; 0 means too dark to measure
        read: (attributes, endpoint) => {
            const value = numberAt(attributes, endpoint, IlluminanceMeasurement.Cluster.id, 0);
            if (value === undefined) {
                return undefined;
            }
            return value <= 0 ? 0 : Math.round(10 ** ((value - 1) / 10000));
        },
        entity: () => ({
            component: "sensor",
            name: "Illuminance",
            device_class: "illuminance",
            unit_of_measurement: "lx",
            state_class: "measurement",
        }),
    },
    measurement("temperature", TemperatureMeasurement.Cluster.id, 0, value => round(value / 100, 2), {
        component: "sensor",
        name: "Temperature",
        device_class: "temperature",
        unit_of_measurement: "°C",
        state_class: "measurement",
    }),
    measurement("humidity", RelativeHumidityMeasurement.Cluster.id, 0, value => round(value / 100, 2), {
        component: "sensor",
        name: "Humidity",
        device_class: "humidity",
        unit_of_measurement: "%",
        state_class: "measurement",
    }),
    // MeasuredValue is in 0.1 kPa, which is exactly hPa
    measurement("pressure", PressureMeasurement.Cluster.id, 0, value => value, {
        component: "sensor",
        name: "Pressure",
        device_class: "pressure",
        unit_of_measurement: "hPa",
        state_class: "measurement",
    }),
    measurement("flow", FlowMeasurement.Cluster.id, 0, value => round(value / 10, 1), {
        component: "sensor",
        name: "Flow",
        device_class: "volume_flow_rate",
        unit_of_measurement: "m³/h",
        state_class: "measurement",
    }),
    measurement("soil_moisture", SoilMeasurement.Cluster.id, 1, value => value, {
        component: "sensor",
        name: "Soil moisture",
        device_class: "moisture",
        unit_of_measurement: "%",
        state_class: "measurement",
    }),
    enumeration(
        "air_quality",
        AirQuality.Cluster.id,
        0,
        ["unknown", "good", "fair", "moderate", "poor", "very_poor", "extremely_poor"],
        { name: "Air quality" },
    ),
    ...concentration("co2", "CO2", CarbonDioxideConcentrationMeasurement.Cluster.id, 0, {
        parts: { ...PPM, deviceClass: "carbon_dioxide" },
    }),
    ...concentration("co", "CO", CarbonMonoxideConcentrationMeasurement.Cluster.id, 0, {
        parts: { ...PPM, deviceClass: "carbon_monoxide" },
    }),
    ...concentration("pm1", "PM1", Pm1ConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "pm1" },
    }),
    ...concentration("pm25", "PM2.5", Pm25ConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "pm25" },
    }),
    ...concentration("pm10", "PM10", Pm10ConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "pm10" },
    }),
    ...concentration("voc", "VOC", TotalVolatileOrganicCompoundsConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "volatile_organic_compounds" },
        parts: { ...PPB, deviceClass: "volatile_organic_compounds_parts" },
    }),
    // zigbee2mqtt's spelling
    ...concentration("formaldehyd", "Formaldehyde", FormaldehydeConcentrationMeasurement.Cluster.id, 3, {
        mass: MG_M3,
        parts: PPM,
    }),
    ...concentration("no2", "NO2", NitrogenDioxideConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "nitrogen_dioxide" },
        parts: PPB,
    }),
    ...concentration("o3", "Ozone", OzoneConcentrationMeasurement.Cluster.id, 4, {
        mass: { ...UG_M3, deviceClass: "ozone" },
        parts: PPB,
    }),
    ...concentration("radon", "Radon", RadonConcentrationMeasurement.Cluster.id, 7, {}),
    flag("smoke", SMOKE_CO, 1, ALARM_ACTIVE, { name: "Smoke", device_class: "smoke" }),
    enumeration("smoke_state", SMOKE_CO, 1, ALARM_STATE_NAMES, { name: "Smoke state" }),
    flag("carbon_monoxide", SMOKE_CO, 2, ALARM_ACTIVE, { name: "Carbon monoxide", device_class: "carbon_monoxide" }),
    enumeration("co_state", SMOKE_CO, 2, ALARM_STATE_NAMES, { name: "CO state" }),
    enumeration(
        "alarm_state",
        SMOKE_CO,
        0,
        [
            "normal",
            "smoke_alarm",
            "co_alarm",
            "battery_alert",
            "testing",
            "hardware_fault",
            "end_of_service",
            "interconnect_smoke",
            "interconnect_co",
            "inoperative",
        ],
        { name: "Alarm state" },
    ),
    flag("interconnect_smoke", SMOKE_CO, 8, ALARM_ACTIVE, { name: "Interconnected smoke", device_class: "smoke" }),
    flag("interconnect_co", SMOKE_CO, 9, ALARM_ACTIVE, {
        name: "Interconnected CO",
        device_class: "carbon_monoxide",
    }),
    flag("test", SMOKE_CO, 5, value => (typeof value === "boolean" ? value : undefined), {
        name: "Self test",
        entity_category: "diagnostic",
    }),
    flag("muted", SMOKE_CO, 4, value => (typeof value === "number" ? value === 1 : undefined), {
        name: "Muted",
        entity_category: "diagnostic",
    }),
    flag("battery_low", SMOKE_CO, 3, ALARM_ACTIVE, {
        name: "Battery low",
        device_class: "battery",
        entity_category: "diagnostic",
    }),
    flag("hardware_fault", SMOKE_CO, 6, value => (typeof value === "boolean" ? value : undefined), {
        name: "Hardware fault",
        device_class: "problem",
        entity_category: "diagnostic",
    }),
    flag("end_of_service", SMOKE_CO, 7, value => (typeof value === "number" ? value === 1 : undefined), {
        name: "End of service",
        device_class: "problem",
        entity_category: "diagnostic",
    }),
    enumeration("contamination", SMOKE_CO, 10, ["normal", "low", "warning", "critical"], {
        name: "Contamination",
        entity_category: "diagnostic",
    }),
    electrical("power", [8], value => round(value / 1000, 2), {
        component: "sensor",
        name: "Power",
        device_class: "power",
        unit_of_measurement: "W",
        state_class: "measurement",
    }),
    electrical("voltage", [4, 11], value => round(value / 1000, 2), {
        component: "sensor",
        name: "Voltage",
        device_class: "voltage",
        unit_of_measurement: "V",
        state_class: "measurement",
    }),
    electrical("current", [5, 12], value => round(value / 1000, 3), {
        component: "sensor",
        name: "Current",
        device_class: "current",
        unit_of_measurement: "A",
        state_class: "measurement",
    }),
    electrical("ac_frequency", [14], value => round(value / 1000, 2), {
        component: "sensor",
        name: "AC frequency",
        device_class: "frequency",
        unit_of_measurement: "Hz",
        state_class: "measurement",
    }),
    energy("energy", 1, "Energy"),
    energy("produced_energy", 2, "Produced energy"),
    // A latching switch rests in a position; a momentary one only passes through it, reported as actions
    {
        key: "switch_position",
        paths: [`${Switch.Cluster.id}/1`],
        present: (attributes, endpoint) => {
            const features = numberAt(attributes, endpoint, Switch.Cluster.id, 65532);
            return (
                features !== undefined &&
                (features & 1) !== 0 &&
                hasAttribute(attributes, endpoint, Switch.Cluster.id, 1)
            );
        },
        read: (attributes, endpoint) => numberAt(attributes, endpoint, Switch.Cluster.id, 1),
        entity: () => ({ component: "sensor", name: "Switch position" }),
    },
];

const POWER_SOURCE = PowerSource.Cluster.id;

/**
 * Properties of the device as a whole, each read from the first PowerSource endpoint that has its
 * attribute. An endpoint property of the same key (a smoke alarm's battery alert, a meter's mains
 * voltage) takes precedence.
 */
export const DEVICE_SENSORS: readonly SensorProperty[] = [
    measurement("battery", POWER_SOURCE, 12, value => Math.round(value / 2), {
        component: "sensor",
        name: "Battery",
        device_class: "battery",
        unit_of_measurement: "%",
        state_class: "measurement",
        entity_category: "diagnostic",
    }),
    flag("battery_low", POWER_SOURCE, 14, ALARM_ACTIVE, {
        name: "Battery low",
        device_class: "battery",
        entity_category: "diagnostic",
    }),
    // zigbee2mqtt reports battery voltage in mV
    measurement("voltage", POWER_SOURCE, 11, value => value, {
        component: "sensor",
        name: "Battery voltage",
        device_class: "voltage",
        unit_of_measurement: "mV",
        state_class: "measurement",
        entity_category: "diagnostic",
    }),
];

/** The endpoint a device-level property is read from: the first, in endpoint order, that has it. */
export function deviceSensorEndpointOf(attributes: AttributesData, property: SensorProperty): number | undefined {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const endpoint = Number(path.split("/", 1)[0]);
        if (Number.isInteger(endpoint)) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b).find(endpoint => property.present(attributes, endpoint));
}
