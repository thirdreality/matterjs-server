/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { PowerSource } from "@matter/main/clusters";
import { controlsOf } from "./Controls.js";
import { endpointPropertyKeysOf, propertyNameResolver } from "./DeviceState.js";
import { deviceActionsOf } from "./Events.js";
import type { LightCapabilities } from "./LightCapabilities.js";
import { DEVICE_SENSORS, deviceSensorEndpointOf, ENDPOINT_SENSORS, type SensorProperty } from "./Sensors.js";
import { COLOR_TEMP_PRESETS } from "./SetCommands.js";

/** zigbee2mqtt access bits: published in the state, settable via `/set`, readable via `/get`. */
export const ACCESS_STATE = 1;
export const ACCESS_SET = 2;
export const ACCESS_GET = 4;

const READ_ONLY = ACCESS_STATE | ACCESS_GET;
const READ_WRITE = ACCESS_STATE | ACCESS_SET | ACCESS_GET;

/** A zigbee2mqtt `definition.exposes` entry. */
export type Expose = Record<string, unknown>;

/**
 * zigbee2mqtt `exposes` for a device: one generic `light`/`switch` per OnOff endpoint, then one entry per
 * sensor property, then the device-level properties. Property names carry the same `_<endpoint>` suffix
 * the state uses, and a suffixed expose names its endpoint, as zigbee2mqtt does for multi-endpoint devices.
 */
export function exposesOf(
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
): Expose[] {
    const nameOf = propertyNameResolver(attributes, endpoints, capsOf);
    const exposes: Expose[] = [];

    for (const endpoint of endpoints) {
        const caps = capsOf(endpoint);
        const withEndpoint = (key: string, expose: Expose): Expose =>
            nameOf(endpoint, key) === key ? expose : { ...expose, endpoint: String(endpoint) };
        const feature = (key: string, label: string, extra: Expose): Expose =>
            withEndpoint(key, { name: key, label, property: nameOf(endpoint, key), access: READ_WRITE, ...extra });

        if (caps.onOff) {
            const features: Expose[] = [
                feature("state", "State", {
                    type: "binary",
                    value_on: "ON",
                    value_off: "OFF",
                    value_toggle: "TOGGLE",
                }),
            ];
            if (caps.brightness) {
                features.push(feature("brightness", "Brightness", { type: "numeric", value_min: 0, value_max: 254 }));
            }
            if (caps.colorTemp) {
                const min = caps.colorTempMinMireds ?? 153;
                const max = caps.colorTempMaxMireds ?? 500;
                const presets = Object.entries(COLOR_TEMP_PRESETS)
                    .map(([name, value]) => ({ name, value: value === "min" ? min : value === "max" ? max : value }))
                    .filter(({ value }) => value >= min && value <= max);
                features.push(
                    feature("color_temp", "Color temp", {
                        type: "numeric",
                        unit: "mired",
                        value_min: min,
                        value_max: max,
                        presets,
                    }),
                );
            }
            const color = (name: string, label: string, components: [string, string][]) =>
                withEndpoint("color", {
                    type: "composite",
                    name,
                    label,
                    property: nameOf(endpoint, "color"),
                    access: READ_WRITE,
                    features: components.map(([key, componentLabel]) => ({
                        type: "numeric",
                        name: key,
                        label: componentLabel,
                        property: key,
                        access: READ_WRITE,
                    })),
                });
            if (caps.xy) {
                features.push(
                    color("color_xy", "Color (X/Y)", [
                        ["x", "X"],
                        ["y", "Y"],
                    ]),
                );
            }
            if (caps.hueSaturation) {
                features.push(
                    color("color_hs", "Color (HS)", [
                        ["hue", "Hue"],
                        ["saturation", "Saturation"],
                    ]),
                );
            }
            exposes.push(withEndpoint("state", { type: caps.brightness ? "light" : "switch", features }));
        }

        for (const control of controlsOf(attributes, endpoint)) {
            for (const expose of control.exposes(attributes, endpoint, key => nameOf(endpoint, key))) {
                exposes.push(withEndpoint(control.primaryKey, expose));
            }
        }

        for (const sensor of ENDPOINT_SENSORS) {
            if (sensor.present(attributes, endpoint)) {
                exposes.push(
                    withEndpoint(sensor.key, sensorExpose(sensor, attributes, endpoint, nameOf(endpoint, sensor.key))),
                );
            }
        }
    }

    const actions = deviceActionsOf(attributes);
    if (actions.length > 0) {
        exposes.push({
            type: "enum",
            name: "action",
            label: "Action",
            property: "action",
            access: ACCESS_STATE,
            values: actions,
        });
    }

    const endpointKeys = new Set(
        endpoints.flatMap(endpoint => endpointPropertyKeysOf(attributes, endpoint, capsOf(endpoint))),
    );
    for (const sensor of DEVICE_SENSORS) {
        const endpoint = deviceSensorEndpointOf(attributes, sensor);
        if (endpoint !== undefined && !endpointKeys.has(sensor.key)) {
            exposes.push(sensorExpose(sensor, attributes, endpoint, sensor.key));
        }
    }

    return exposes;
}

function sensorExpose(sensor: SensorProperty, attributes: AttributesData, endpoint: number, property: string): Expose {
    const entity = sensor.entity(attributes, endpoint);
    const base = { name: sensor.key, label: entity.name, property, access: READ_ONLY };
    if (entity.component === "binary_sensor") {
        const on = entity.payload_on ?? true;
        return { type: "binary", ...base, value_on: on, value_off: !on };
    }
    if (entity.options !== undefined) {
        return { type: "enum", ...base, values: entity.options };
    }
    return {
        type: "numeric",
        ...base,
        ...(entity.unit_of_measurement === undefined ? {} : { unit: entity.unit_of_measurement }),
    };
}

const POWER_SOURCE = PowerSource.Cluster.id;

/**
 * zigbee2mqtt `power_source` from the node's primary PowerSource (the lowest Order): `Mains (single phase)`
 * or `DC Source` for a wired source, `Battery` for a battery one; undefined when the node reports none.
 */
export function powerSourceOf(attributes: AttributesData): string | undefined {
    let primary: { order: number; endpoint: number } | undefined;
    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster !== POWER_SOURCE || attribute !== 65532 || endpoint === undefined) {
            continue;
        }
        const order = attributes[`${endpoint}/${POWER_SOURCE}/1`];
        const rank = typeof order === "number" ? order : Number.MAX_SAFE_INTEGER;
        if (primary === undefined || rank < primary.order) {
            primary = { order: rank, endpoint };
        }
    }
    if (primary === undefined) {
        return undefined;
    }
    const features = attributes[`${primary.endpoint}/${POWER_SOURCE}/65532`];
    if (typeof features !== "number") {
        return undefined;
    }
    // FeatureMap bit 0 = Wired, bit 1 = Battery; WiredCurrentType 0 = AC, 1 = DC
    if (features & 1) {
        return attributes[`${primary.endpoint}/${POWER_SOURCE}/5`] === 1 ? "DC Source" : "Mains (single phase)";
    }
    if (features & 2) {
        return "Battery";
    }
    return undefined;
}

/**
 * The zigbee2mqtt fields of a `bridge/devices` entry that describe what the device is and offers.
 * `friendly_name` is the topic segment. `basicInformation` is the `<endpoint>/<cluster>` of the
 * BasicInformation (`0/40`) or, for a bridged device, BridgedDeviceBasicInformation, which share the
 * attribute ids used here.
 */
export function deviceDescriptionOf(
    device: string,
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
    supportsOta: boolean,
    basicInformation = "0/40",
): Record<string, unknown> {
    const text = (path: string) => {
        const value = attributes[path];
        return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    };
    const vendor = text(`${basicInformation}/1`);
    const model = text(`${basicInformation}/3`);
    return {
        friendly_name: device,
        supported: true,
        manufacturer: vendor,
        model_id: model,
        software_build_id: text(`${basicInformation}/10`),
        power_source: powerSourceOf(attributes),
        definition: {
            model,
            vendor,
            description: model,
            exposes: exposesOf(attributes, endpoints, capsOf),
            options: [],
            supports_ota: supportsOta,
        },
    };
}
