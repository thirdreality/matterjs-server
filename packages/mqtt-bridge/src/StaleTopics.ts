/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { DISCOVERY_PREFIX } from "./Topics.js";

/**
 * What the bridge currently expects to exist, for judging a retained topic that is still on the
 * broker.
 */
export interface RetainedContext {
    /** The bridge's topic prefix. */
    prefix: string;
    /** Every discovery config the bridge publishes right now, bridge entities included. */
    expectedDiscovery: ReadonlySet<string>;
    /** Devices the bridge currently knows about. */
    knownDevices: ReadonlySet<string>;
}

/**
 * Whether a retained topic should be cleared, and why.
 *
 * A retained topic outlives the process that published it, so anything the bridge stops publishing
 * stays on the broker until someone removes it: entities dropped or renamed between versions keep
 * showing up in Home Assistant, and the state of a decommissioned node keeps describing a device
 * that no longer exists. Per-device discovery is already reconciled against the previous publish,
 * but that only covers changes this process made.
 *
 * Only a topic that is provably ours is a candidate. For a discovery config that means its payload
 * references our topic prefix — the object ids alone are not enough, since a second bridge on a
 * different prefix publishes the same shapes. Anything unrecognized is left alone: a stale entity is
 * a cosmetic problem, while deleting someone else's discovery config breaks their integration.
 *
 * @returns the reason to clear the topic, or undefined to leave it alone
 */
export function staleRetainedReason(topic: string, payload: string, ctx: RetainedContext): string | undefined {
    if (payload.trim().length === 0) {
        // Already cleared, or the clear we published ourselves coming back
        return undefined;
    }

    if (topic.startsWith(`${DISCOVERY_PREFIX}/`)) {
        if (ctx.expectedDiscovery.has(topic)) {
            return undefined;
        }
        // The quote anchors the match to a whole prefix, so "matter2mqtt" does not claim a config
        // belonging to "matter2mqtt2" or to "home/matter2mqtt"
        if (!payload.includes(`"${ctx.prefix}/`)) {
            return undefined;
        }
        return "the bridge no longer publishes this entity";
    }

    if (!topic.startsWith(`${ctx.prefix}/`)) {
        return undefined;
    }
    const segments = topic.slice(ctx.prefix.length + 1).split("/");
    const device = segments[0];
    // Only state and availability are retained per device; command topics are not ours to judge
    const isDeviceTopic = segments.length === 1 || (segments.length === 2 && segments[1] === "availability");
    if (!isDeviceTopic || device === undefined || device === "" || device === "bridge") {
        return undefined;
    }
    if (ctx.knownDevices.has(device)) {
        return undefined;
    }
    return "no such device is commissioned";
}
