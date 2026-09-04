/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { ONOFF_CLUSTER_ID } from "./LightCapabilities.js";

/** OnOff attribute id 0 ("OnOff") in the WebSocket path format `<endpoint>/6/0`. */
const ONOFF_ATTRIBUTE_ID = 0;

export { ONOFF_CLUSTER_ID };

/** Endpoints of a node that expose the OnOff cluster, derived from cached attribute paths. */
export function onOffEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Array<number>();
    const suffix = `/${ONOFF_CLUSTER_ID}/${ONOFF_ATTRIBUTE_ID}`;
    for (const path of Object.keys(attributes)) {
        if (path.endsWith(suffix)) {
            const endpoint = parseInt(path, 10);
            if (!isNaN(endpoint)) {
                endpoints.push(endpoint);
            }
        }
    }
    return endpoints.sort((a, b) => a - b);
}

/** Cached OnOff attribute value for an endpoint, or undefined if unknown. */
export function onOffValueOf(attributes: AttributesData, endpoint: number): boolean | undefined {
    const value = attributes[`${endpoint}/${ONOFF_CLUSTER_ID}/${ONOFF_ATTRIBUTE_ID}`];
    return typeof value === "boolean" ? value : undefined;
}

/** Device state topic payload for an OnOff value. */
export function onOffStatePayload(on: boolean): string {
    return JSON.stringify({ state: on ? "ON" : "OFF" });
}
