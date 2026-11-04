/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { BridgedDeviceBasicInformation, Descriptor } from "@matter/main/clusters";

export const BRIDGED_BASIC_INFORMATION_CLUSTER_ID = BridgedDeviceBasicInformation.Cluster.id;
/** BridgedDeviceBasicInformation Reachable. */
export const BRIDGED_REACHABLE_ATTRIBUTE_ID = 17;

const PARTS_LIST = 3;
/** Deeper than any composed device; only guards against a parent cycle in bad data. */
const MAX_DEPTH = 16;

function endpointsOf(attributes: AttributesData): number[] {
    const endpoints = new Set<number>();
    for (const path of Object.keys(attributes)) {
        const endpoint = Number(path.slice(0, path.indexOf("/")));
        if (Number.isInteger(endpoint)) {
            endpoints.add(endpoint);
        }
    }
    return [...endpoints].sort((a, b) => a - b);
}

function hasCluster(attributes: AttributesData, endpoint: number, cluster: number): boolean {
    const prefix = `${endpoint}/${cluster}/`;
    return Object.keys(attributes).some(path => path.startsWith(prefix));
}

/**
 * The devices behind a Matter bridge, by the endpoint that carries their BridgedDeviceBasicInformation,
 * each with all endpoints that belong to it (a bridged dual switch has two child endpoints). Membership
 * follows `endpointParents` up to the bridged endpoint, else the bridged endpoint's PartsList.
 */
export function bridgedDevicesOf(
    attributes: AttributesData,
    endpointParents?: Readonly<Record<string, number>>,
): Map<number, Set<number>> {
    const endpoints = endpointsOf(attributes);
    const bridged = endpoints.filter(endpoint =>
        hasCluster(attributes, endpoint, BRIDGED_BASIC_INFORMATION_CLUSTER_ID),
    );
    const devices = new Map(bridged.map(endpoint => [endpoint, new Set([endpoint])]));
    if (devices.size === 0) {
        return devices;
    }
    const hasParents = endpointParents !== undefined && Object.keys(endpointParents).length > 0;
    for (const endpoint of endpoints) {
        if (devices.has(endpoint)) {
            continue;
        }
        let owner: number | undefined;
        if (hasParents) {
            let current: number | undefined = endpointParents[String(endpoint)];
            for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
                if (devices.has(current)) {
                    owner = current;
                    break;
                }
                current = endpointParents[String(current)];
            }
        } else {
            owner = bridged.find(candidate => {
                const parts = attributes[`${candidate}/${Descriptor.Cluster.id}/${PARTS_LIST}`];
                return Array.isArray(parts) && parts.includes(endpoint);
            });
        }
        if (owner !== undefined) {
            devices.get(owner)?.add(endpoint);
        }
    }
    return devices;
}

/** The topic segment of a bridged device: the bridge's node id and the device's endpoint. */
export function bridgedDeviceKey(node: string, endpoint: number): string {
    return `${node}_${endpoint}`;
}

/** The attributes of the given endpoints only, so a bridged device is handled like a node of its own. */
export function scopedAttributes(attributes: AttributesData, keep: (endpoint: number) => boolean): AttributesData {
    const scoped: AttributesData = {};
    for (const [path, value] of Object.entries(attributes)) {
        if (keep(Number(path.slice(0, path.indexOf("/"))))) {
            scoped[path] = value;
        }
    }
    return scoped;
}
