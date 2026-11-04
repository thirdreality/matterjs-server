/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { Switch } from "@matter/main/clusters";

export const SWITCH_CLUSTER_ID = Switch.Cluster.id;

const SWITCH_LATCHED = 0;
const INITIAL_PRESS = 1;
const LONG_PRESS = 2;
const SHORT_RELEASE = 3;
const LONG_RELEASE = 4;
const MULTI_PRESS_COMPLETE = 6;

const FEATURE_LATCHING = 1;
const FEATURE_MOMENTARY = 2;
const FEATURE_RELEASE = 4;
const FEATURE_LONG_PRESS = 8;
const FEATURE_MULTI_PRESS = 16;

/** zigbee2mqtt names for a press count; beyond four presses zigbee2mqtt devices say `many`. */
const PRESS_COUNTS = ["single", "double", "triple", "quadruple"] as const;

function pressCountAction(count: number): string {
    return PRESS_COUNTS[count - 1] ?? "many";
}

function featuresOf(attributes: AttributesData, endpoint: number): number | undefined {
    const value = attributes[`${endpoint}/${SWITCH_CLUSTER_ID}/65532`];
    return typeof value === "number" ? value : undefined;
}

/** Endpoints carrying the Switch cluster (buttons, rockers, doorbells). */
export function switchEndpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const [endpoint, cluster, attribute] = path.split("/").map(Number);
        if (cluster === SWITCH_CLUSTER_ID && attribute === 65532 && endpoint !== undefined) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b);
}

/** An event field, keyed by name (matter.js) or TLV tag. */
function field(data: unknown, tag: number, name: string): unknown {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }
    const record = data as Record<string, unknown>;
    return record[name] ?? record[String(tag)];
}

/**
 * The actions an endpoint can report, from its Switch features. A momentary press is reported once:
 * by MultiPressComplete with the multi-press feature, else by ShortRelease with the release feature,
 * else by InitialPress.
 */
function endpointActionsOf(attributes: AttributesData, endpoint: number): string[] {
    const features = featuresOf(attributes, endpoint) ?? 0;
    const actions: string[] = [];
    if (features & FEATURE_LATCHING) {
        const positions = attributes[`${endpoint}/${SWITCH_CLUSTER_ID}/0`];
        const count = typeof positions === "number" ? positions : 2;
        for (let position = 0; position < count; position++) {
            actions.push(`position_${position}`);
        }
    }
    if (features & FEATURE_MOMENTARY) {
        const max = attributes[`${endpoint}/${SWITCH_CLUSTER_ID}/2`];
        const presses = features & FEATURE_MULTI_PRESS && typeof max === "number" ? Math.max(1, max) : 1;
        for (let count = 1; count <= Math.min(presses, PRESS_COUNTS.length); count++) {
            actions.push(pressCountAction(count));
        }
        if (presses > PRESS_COUNTS.length) {
            actions.push("many");
        }
        if (features & FEATURE_LONG_PRESS) {
            actions.push("hold", "release");
        }
    }
    return actions;
}

/** The suffix that tells the buttons of a multi-button device apart, as zigbee2mqtt's `single_left`. */
function suffixFor(attributes: AttributesData, endpoint: number): string {
    return switchEndpointsOf(attributes).length > 1 ? `_${endpoint}` : "";
}

/** Every action value the device can publish, for Home Assistant event types and triggers. */
export function deviceActionsOf(attributes: AttributesData): string[] {
    return switchEndpointsOf(attributes).flatMap(endpoint =>
        endpointActionsOf(attributes, endpoint).map(action => `${action}${suffixFor(attributes, endpoint)}`),
    );
}

/** The zigbee2mqtt `action` for a Switch event, or undefined when the event does not report one. */
export function switchActionOf(
    attributes: AttributesData,
    endpoint: number,
    eventId: number,
    data: unknown,
): string | undefined {
    const features = featuresOf(attributes, endpoint) ?? 0;
    let action: string | undefined;
    switch (eventId) {
        case SWITCH_LATCHED: {
            const position = field(data, 0, "newPosition");
            action = typeof position === "number" ? `position_${position}` : undefined;
            break;
        }
        case INITIAL_PRESS:
            action = features & (FEATURE_RELEASE | FEATURE_MULTI_PRESS) ? undefined : "single";
            break;
        case SHORT_RELEASE:
            action = features & FEATURE_MULTI_PRESS ? undefined : "single";
            break;
        case LONG_PRESS:
            action = "hold";
            break;
        case LONG_RELEASE:
            action = "release";
            break;
        case MULTI_PRESS_COMPLETE: {
            const count = field(data, 1, "totalNumberOfPressesCounted");
            action = typeof count === "number" && count > 0 ? pressCountAction(count) : undefined;
            break;
        }
    }
    return action === undefined ? undefined : `${action}${suffixFor(attributes, endpoint)}`;
}
