/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { OnOff } from "@matter/main/clusters";

/** OnOff attribute id 0 ("OnOff") in the WebSocket path format `<endpoint>/6/0`. */
const ONOFF_ATTRIBUTE_ID = 0;

export const ONOFF_CLUSTER_ID = OnOff.Cluster.id;

export type OnOffCommand = "on" | "off" | "toggle";

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

/**
 * Parse a set command payload. Accepts a bare string (`ON`, `off`, `Toggle`), a JSON
 * string, a JSON boolean, or a JSON object with a `state` member of any of those forms.
 * Returns undefined for anything else.
 */
export function parseSetCommand(payload: string): OnOffCommand | undefined {
    let value: unknown = payload.trim();
    try {
        value = JSON.parse(payload);
    } catch {
        // Not JSON: treat the raw string as the state value
    }
    if (typeof value === "object" && value !== null) {
        value = (value as Record<string, unknown>).state;
    }
    if (typeof value === "boolean") {
        return value ? "on" : "off";
    }
    if (typeof value !== "string") {
        return undefined;
    }
    switch (value.trim().toLowerCase()) {
        case "on":
            return "on";
        case "off":
            return "off";
        case "toggle":
            return "toggle";
        default:
            return undefined;
    }
}
