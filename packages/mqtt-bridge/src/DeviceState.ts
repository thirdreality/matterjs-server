/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import {
    BooleanState,
    IlluminanceMeasurement,
    OccupancySensing,
    PowerSource,
    RelativeHumidityMeasurement,
    TemperatureMeasurement,
} from "@matter/main/clusters";
import { COLOR_CLUSTER_ID, LEVEL_CLUSTER_ID, ONOFF_CLUSTER_ID, type LightCapabilities } from "./LightCapabilities.js";

const OCCUPANCY_CLUSTER_ID = OccupancySensing.Cluster.id;
const ILLUMINANCE_CLUSTER_ID = IlluminanceMeasurement.Cluster.id;
const TEMPERATURE_CLUSTER_ID = TemperatureMeasurement.Cluster.id;
const HUMIDITY_CLUSTER_ID = RelativeHumidityMeasurement.Cluster.id;
const POWER_SOURCE_CLUSTER_ID = PowerSource.Cluster.id;
const BOOLEAN_STATE_CLUSTER_ID = BooleanState.Cluster.id;

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
    `${OCCUPANCY_CLUSTER_ID}/0`,
    `${ILLUMINANCE_CLUSTER_ID}/0`,
    `${TEMPERATURE_CLUSTER_ID}/0`,
    `${HUMIDITY_CLUSTER_ID}/0`,
    `${POWER_SOURCE_CLUSTER_ID}/12`, // batPercentRemaining
    `${BOOLEAN_STATE_CLUSTER_ID}/0`, // stateValue
]);

/** True when a changed attribute path affects the published device state. */
export function isStateAttribute(clusterId: number, attributeId: number): boolean {
    return STATE_ATTRIBUTE_PATHS.has(`${clusterId}/${attributeId}`);
}

/** Endpoints of a node that contribute properties to the device state. */
export function relevantEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (endpoint === undefined || cluster === undefined || attribute !== 0) {
            continue;
        }
        const stateClusters: number[] = [
            ONOFF_CLUSTER_ID,
            OCCUPANCY_CLUSTER_ID,
            ILLUMINANCE_CLUSTER_ID,
            TEMPERATURE_CLUSTER_ID,
            HUMIDITY_CLUSTER_ID,
            BOOLEAN_STATE_CLUSTER_ID,
        ];
        if (stateClusters.includes(cluster)) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b);
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
 * zigbee2mqtt-style state properties of one endpoint, read from the attribute cache.
 * Value conventions follow z2m: hue 0-360, saturation 0-100, x/y 4 decimals,
 * illuminance in lux, temperature/humidity in real units.
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
        const colorMode = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 8);
        if (colorMode === 0) {
            state.color_mode = "hs";
            const enhancedHue = caps.enhancedHue ? numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 16384) : undefined;
            const hue = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 0);
            const saturation = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 1);
            const color: Record<string, number> = {};
            if (enhancedHue !== undefined) {
                color.hue = Math.round((enhancedHue / 65535) * 360);
            } else if (hue !== undefined) {
                color.hue = Math.round((hue / 254) * 360);
            }
            if (saturation !== undefined) {
                color.saturation = Math.round((saturation / 254) * 100);
            }
            if (Object.keys(color).length > 0) {
                state.color = color;
            }
        } else if (colorMode === 1) {
            state.color_mode = "xy";
            const x = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 3);
            const y = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 4);
            if (x !== undefined && y !== undefined) {
                state.color = { x: round(x / 65535, 4), y: round(y / 65535, 4) };
            }
        } else if (colorMode === 2) {
            state.color_mode = "color_temp";
        }
        if (caps.colorTemp) {
            const mireds = numberOf(attributes, endpoint, COLOR_CLUSTER_ID, 7);
            if (mireds !== undefined) {
                state.color_temp = mireds;
            }
        }
    }

    const occupancy = attributes[`${endpoint}/${OCCUPANCY_CLUSTER_ID}/0`];
    if (typeof occupancy === "number") {
        state.occupancy = (occupancy & 1) !== 0;
    } else if (typeof occupancy === "object" && occupancy !== null) {
        state.occupancy = (occupancy as { occupied?: boolean }).occupied === true;
    }

    // Matter and Zigbee share the encoding: MeasuredValue = 10000*log10(lux) + 1
    const illuminanceRaw = numberOf(attributes, endpoint, ILLUMINANCE_CLUSTER_ID, 0);
    if (illuminanceRaw !== undefined && illuminanceRaw > 0) {
        state.illuminance = Math.round(10 ** ((illuminanceRaw - 1) / 10000));
    }

    const temperature = numberOf(attributes, endpoint, TEMPERATURE_CLUSTER_ID, 0);
    if (temperature !== undefined) {
        state.temperature = round(temperature / 100, 2);
    }

    const humidity = numberOf(attributes, endpoint, HUMIDITY_CLUSTER_ID, 0);
    if (humidity !== undefined) {
        state.humidity = round(humidity / 100, 2);
    }

    const contact = attributes[`${endpoint}/${BOOLEAN_STATE_CLUSTER_ID}/0`];
    if (typeof contact === "boolean") {
        state.contact = contact;
    }

    return state;
}

/**
 * Assemble the full zigbee2mqtt-style device state: single relevant endpoint publishes
 * plain properties, multiple endpoints use the z2m `_<endpoint>` property suffix.
 * `battery` is device-level (first PowerSource occurrence, usually endpoint 0).
 */
export function deviceStateOf(
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
): Record<string, unknown> {
    const device: Record<string, unknown> = {};
    const multi = endpoints.length > 1;
    for (const endpoint of endpoints) {
        const state = endpointStateOf(attributes, endpoint, capsOf(endpoint));
        for (const [key, value] of Object.entries(state)) {
            device[multi ? `${key}_${endpoint}` : key] = value;
        }
    }

    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster === POWER_SOURCE_CLUSTER_ID && attribute === 12 && endpoint !== undefined) {
            const raw = attributes[path];
            if (typeof raw === "number") {
                device.battery = Math.round(raw / 2);
            }
            break;
        }
    }

    return device;
}
