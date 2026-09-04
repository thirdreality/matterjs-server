/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { ColorControl, LevelControl, OnOff } from "@matter/main/clusters";

export const ONOFF_CLUSTER_ID = OnOff.Cluster.id;
export const LEVEL_CLUSTER_ID = LevelControl.Cluster.id;
export const COLOR_CLUSTER_ID = ColorControl.Cluster.id;

const FEATURE_MAP_ATTRIBUTE_ID = 65532;
/** ColorControl feature bits (Matter spec 3.2.4). */
const COLOR_FEATURE_HS = 1 << 0;
const COLOR_FEATURE_ENHANCED_HUE = 1 << 1;
const COLOR_FEATURE_XY = 1 << 3;
const COLOR_FEATURE_COLOR_TEMP = 1 << 4;

/** zigbee2mqtt-style controllable capabilities of one endpoint, derived from the attribute cache. */
export interface LightCapabilities {
    onOff: boolean;
    brightness: boolean;
    /** LevelControl min/max level bounds (defaults 1..254). */
    minLevel: number;
    maxLevel: number;
    hueSaturation: boolean;
    enhancedHue: boolean;
    xy: boolean;
    colorTemp: boolean;
    /** ColorTempPhysicalMin/MaxMireds, for clamping color_temp (undefined: no clamping bound). */
    colorTempMinMireds?: number;
    colorTempMaxMireds?: number;
}

function numberAttribute(attributes: AttributesData, path: string): number | undefined {
    const value = attributes[path];
    return typeof value === "number" ? value : undefined;
}

/** Derive the light capabilities of an endpoint from cached attributes. */
export function lightCapabilitiesOf(attributes: AttributesData, endpoint: number): LightCapabilities {
    const onOff = attributes[`${endpoint}/${ONOFF_CLUSTER_ID}/0`] !== undefined;
    const brightness = attributes[`${endpoint}/${LEVEL_CLUSTER_ID}/0`] !== undefined;
    const colorFeatures =
        numberAttribute(attributes, `${endpoint}/${COLOR_CLUSTER_ID}/${FEATURE_MAP_ATTRIBUTE_ID}`) ?? 0;

    return {
        onOff,
        brightness,
        minLevel: numberAttribute(attributes, `${endpoint}/${LEVEL_CLUSTER_ID}/2`) ?? 1,
        maxLevel: numberAttribute(attributes, `${endpoint}/${LEVEL_CLUSTER_ID}/3`) ?? 254,
        hueSaturation: (colorFeatures & COLOR_FEATURE_HS) !== 0,
        enhancedHue: (colorFeatures & COLOR_FEATURE_ENHANCED_HUE) !== 0,
        xy: (colorFeatures & COLOR_FEATURE_XY) !== 0,
        colorTemp: (colorFeatures & COLOR_FEATURE_COLOR_TEMP) !== 0,
        colorTempMinMireds: numberAttribute(attributes, `${endpoint}/${COLOR_CLUSTER_ID}/16395`),
        colorTempMaxMireds: numberAttribute(attributes, `${endpoint}/${COLOR_CLUSTER_ID}/16396`),
    };
}
