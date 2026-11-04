/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { hsvToXY, miredsToXY, xyToHsv, xyToMireds } from "./ColorMath.js";
import { CONTROLS, controlsOf } from "./Controls.js";
import { COLOR_CLUSTER_ID, LEVEL_CLUSTER_ID, ONOFF_CLUSTER_ID, type LightCapabilities } from "./LightCapabilities.js";
import { BASIC_INFORMATION_CLUSTER_ID, OTA_REQUESTOR_CLUSTER_ID } from "./OtaState.js";
import { DEVICE_SENSORS, deviceSensorEndpointOf, ENDPOINT_SENSORS } from "./Sensors.js";

/**
 * Device-level state attributes: they contribute a property to the whole device rather than to one
 * endpoint (`battery`, `update`), so a change on an endpoint outside {@link relevantEndpointsOf}
 * must not be read as a structure change.
 */
export const DEVICE_LEVEL_STATE_PATHS: ReadonlySet<string> = new Set([
    ...DEVICE_SENSORS.flatMap(sensor => sensor.paths),
    `${OTA_REQUESTOR_CLUSTER_ID}/2`, // updateState
    `${OTA_REQUESTOR_CLUSTER_ID}/3`, // updateStateProgress
    `${BASIC_INFORMATION_CLUSTER_ID}/9`, // softwareVersion
    `${BASIC_INFORMATION_CLUSTER_ID}/10`, // softwareVersionString
]);

/** `<cluster>/<attribute>` paths whose changes require a device state re-publish. */
export const STATE_ATTRIBUTE_PATHS: ReadonlySet<string> = new Set([
    `${ONOFF_CLUSTER_ID}/0`,
    `${LEVEL_CLUSTER_ID}/0`,
    `${COLOR_CLUSTER_ID}/0`, // currentHue
    `${COLOR_CLUSTER_ID}/1`, // currentSaturation
    `${COLOR_CLUSTER_ID}/3`, // currentX
    `${COLOR_CLUSTER_ID}/4`, // currentY
    `${COLOR_CLUSTER_ID}/7`, // colorTemperatureMireds
    `${COLOR_CLUSTER_ID}/8`, // colorMode
    `${COLOR_CLUSTER_ID}/16384`, // enhancedCurrentHue
    ...ENDPOINT_SENSORS.flatMap(sensor => sensor.paths),
    ...CONTROLS.flatMap(control => control.paths),
    ...DEVICE_LEVEL_STATE_PATHS,
]);

/** True when a changed attribute path affects the published device state. */
export function isStateAttribute(clusterId: number, attributeId: number): boolean {
    return STATE_ATTRIBUTE_PATHS.has(`${clusterId}/${attributeId}`);
}

/** True for a state attribute that belongs to the device as a whole, not to one endpoint. */
export function isDeviceLevelStateAttribute(clusterId: number, attributeId: number): boolean {
    return DEVICE_LEVEL_STATE_PATHS.has(`${clusterId}/${attributeId}`);
}

/** Endpoints of a node that contribute properties to the device state. */
export function relevantEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const endpoint = Number(path.split("/", 1)[0]);
        if (Number.isInteger(endpoint)) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints]
        .filter(
            endpoint =>
                attributes[`${endpoint}/${ONOFF_CLUSTER_ID}/0`] !== undefined ||
                controlsOf(attributes, endpoint).length > 0 ||
                ENDPOINT_SENSORS.some(sensor => sensor.present(attributes, endpoint)),
        )
        .sort((a, b) => a - b);
}

/**
 * Property names an endpoint can contribute to the device state, based on capabilities
 * rather than current values, so suffix decisions and discovery templates stay stable.
 */
export function endpointPropertyKeysOf(
    attributes: AttributesData,
    endpoint: number,
    caps: LightCapabilities,
): string[] {
    const keys: string[] = [];
    if (caps.onOff) {
        keys.push("state");
    }
    if (caps.brightness) {
        keys.push("brightness");
    }
    if (caps.colorTemp || caps.hueSaturation || caps.xy) {
        keys.push("color_mode");
    }
    if (caps.hueSaturation || caps.xy) {
        keys.push("color");
    }
    if (caps.colorTemp) {
        keys.push("color_temp");
    }
    for (const control of controlsOf(attributes, endpoint)) {
        keys.push(...control.keys(attributes, endpoint));
    }
    for (const sensor of ENDPOINT_SENSORS) {
        if (sensor.present(attributes, endpoint)) {
            keys.push(sensor.key);
        }
    }
    return keys;
}

/**
 * Resolves the published property name per endpoint: plain while unique across the device,
 * the zigbee2mqtt `_<endpoint>` suffix when several endpoints provide the same property.
 */
export function propertyNameResolver(
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
): (endpoint: number, key: string) => string {
    const occurrences = new Map<string, number>();
    for (const endpoint of endpoints) {
        for (const key of endpointPropertyKeysOf(attributes, endpoint, capsOf(endpoint))) {
            occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
        }
    }
    return (endpoint, key) => ((occurrences.get(key) ?? 0) > 1 ? `${key}_${endpoint}` : key);
}

function numberOf(
    attributes: AttributesData,
    endpoint: number,
    cluster: number,
    attribute: number,
): number | undefined {
    const value = attributes[`${endpoint}/${cluster}/${attribute}`];
    return typeof value === "number" ? value : undefined;
}

const round = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

/**
 * The color part of the endpoint state, kept in sync across representations the way zigbee2mqtt's
 * `syncColorState` does: whichever mode the endpoint reports, the other representations the endpoint
 * supports are derived from it, so a consumer never sees a stale value from a previous mode.
 *
 * Deviation: `x`/`y` are published in hs mode even for an endpoint without the xy feature, because
 * Home Assistant's color wheel reads them.
 */
function colorStateOf(attributes: AttributesData, endpoint: number, caps: LightCapabilities): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    const color: Record<string, number> = {};
    const colorMode = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 8);
    let mireds: number | undefined;

    const clampMireds = (value: number) =>
        Math.min(caps.colorTempMaxMireds ?? Infinity, Math.max(caps.colorTempMinMireds ?? 1, value));
    const addHueSaturation = ({ hue, saturation }: { hue: number; saturation: number }) => {
        color.hue = Math.round(hue);
        color.saturation = Math.round(saturation);
        // Home Assistant's MQTT JSON light only reads the short keys
        color.h = color.hue;
        color.s = color.saturation;
    };

    if (colorMode === 0) {
        state.color_mode = "hs";
        const enhancedHue = caps.enhancedHue ? numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 16384) : undefined;
        const hue = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 0);
        const saturation = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 1);
        if (enhancedHue !== undefined) {
            color.hue = Math.round((enhancedHue / 65535) * 360);
        } else if (hue !== undefined) {
            color.hue = Math.round((hue / 254) * 360);
        }
        if (saturation !== undefined) {
            color.saturation = Math.round((saturation / 254) * 100);
        }
        if (color.hue !== undefined && color.saturation !== undefined) {
            color.h = color.hue;
            color.s = color.saturation;
            const xy = hsvToXY(color.hue, color.saturation);
            color.x = xy.x;
            color.y = xy.y;
            if (caps.colorTemp) {
                mireds = clampMireds(xyToMireds(xy));
            }
        }
    } else if (colorMode === 1) {
        state.color_mode = "xy";
        const rawX = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 3);
        const rawY = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 4);
        if (rawX !== undefined && rawY !== undefined) {
            const xy = { x: round(rawX / 65535, 4), y: round(rawY / 65535, 4) };
            color.x = xy.x;
            color.y = xy.y;
            if (caps.hueSaturation) {
                addHueSaturation(xyToHsv(xy));
            }
            if (caps.colorTemp) {
                mireds = clampMireds(xyToMireds(xy));
            }
        }
    } else if (colorMode === 2) {
        state.color_mode = "color_temp";
        mireds = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 7);
        if (mireds !== undefined) {
            const xy = miredsToXY(mireds);
            if (caps.xy) {
                color.x = xy.x;
                color.y = xy.y;
            }
            if (caps.hueSaturation) {
                addHueSaturation(xyToHsv(xy));
            }
        }
    } else if (caps.colorTemp) {
        // Mode unknown: the raw attribute is all we have
        mireds = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 7);
    }

    if (Object.keys(color).length > 0) {
        state.color = color;
    }
    if (mireds !== undefined) {
        state.color_temp = mireds;
    }
    return state;
}

/**
 * zigbee2mqtt-style state properties of one endpoint, read from the attribute cache.
 * Value conventions follow z2m: hue 0-360, saturation 0-100, x/y 4 decimals; sensor units are listed
 * with each property in {@link ENDPOINT_SENSORS}.
 */
export function endpointStateOf(
    attributes: AttributesData,
    endpoint: number,
    caps: LightCapabilities,
): Record<string, unknown> {
    const state: Record<string, unknown> = {};

    if (caps.onOff) {
        const on = attributes[`${endpoint}/${ONOFF_CLUSTER_ID}/0`];
        if (typeof on === "boolean") {
            state.state = on ? "ON" : "OFF";
        }
    }
    if (caps.brightness) {
        const level = numberOf(attributes, endpoint, LEVEL_CLUSTER_ID, 0);
        if (level !== undefined) {
            state.brightness = level;
        }
    }

    if (caps.colorTemp || caps.hueSaturation || caps.xy) {
        Object.assign(state, colorStateOf(attributes, endpoint, caps));
    }

    for (const control of controlsOf(attributes, endpoint)) {
        Object.assign(state, control.state(attributes, endpoint));
    }

    for (const sensor of ENDPOINT_SENSORS) {
        // Several properties can read the same attribute (BooleanState); only the present one may publish
        const value = sensor.present(attributes, endpoint) ? sensor.read(attributes, endpoint) : undefined;
        if (value !== undefined) {
            state[sensor.key] = value;
        }
    }

    return state;
}

/**
 * Assemble the full zigbee2mqtt-style device state. Properties are plain as long as they
 * are unique across endpoints; only a property that several endpoints provide (a true
 * multi-instance device, e.g. a dual relay) gets the z2m `_<endpoint>` suffix.
 * Device-level properties (`battery`, ...) come from the first PowerSource endpoint that has them, unless
 * an endpoint already provides the same key.
 */
export function deviceStateOf(
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
): Record<string, unknown> {
    const nameOf = propertyNameResolver(attributes, endpoints, capsOf);
    const device: Record<string, unknown> = {};
    for (const endpoint of endpoints) {
        const state = endpointStateOf(attributes, endpoint, capsOf(endpoint));
        for (const [key, value] of Object.entries(state)) {
            device[nameOf(endpoint, key)] = value;
        }
    }

    for (const sensor of DEVICE_SENSORS) {
        const endpoint = deviceSensorEndpointOf(attributes, sensor);
        if (endpoint === undefined || sensor.key in device) {
            continue;
        }
        const value = sensor.read(attributes, endpoint);
        if (value !== undefined) {
            device[sensor.key] = value;
        }
    }

    return device;
}
