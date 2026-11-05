/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ControllerCommandHandler } from "@matter-server/ws-controller";
import { NodeId, Observable } from "@matter/main";
import { MqttBridge } from "../src/MqttBridge.js";
import type { BridgeConnection } from "../src/MqttConnection.js";

export interface Published {
    topic: string;
    payload: string;
    retain: boolean;
}

export interface HarnessOptions {
    lastSeen?: boolean;
    withCommands?: boolean;
    endpointParents?: Record<string, number>;
    isBridge?: boolean;
    homeAssistantDiscovery?: boolean;
}

/**
 * An MqttBridge on a fake controller with one node (id 12) and a fake broker connection that records
 * everything published.
 */
export function harness(initial: Record<string, unknown>, options: HarnessOptions = {}) {
    let attributes = { ...initial };
    const published: Published[] = [];
    const invoked: unknown[] = [];
    let onMessage: (topic: string, payload: string) => void = () => {};
    const connection: BridgeConnection = {
        connect: handler => {
            onMessage = handler;
        },
        subscribe: () => {},
        publish: (topic, payload, retain = false) => published.push({ topic, payload, retain }),
        clearRetained: topic => published.push({ topic, payload: "", retain: true }),
        close: () => Promise.resolve(),
    };
    const events = {
        attributeChanged: new Observable<[NodeId, { path: Record<string, number>; value: unknown }]>(),
        eventChanged: new Observable<[NodeId, { path: Record<string, number>; events: { data: unknown }[] }]>(),
        nodeAdded: new Observable<[NodeId]>(),
        nodeStructureChanged: new Observable<[NodeId]>(),
        nodeAvailabilityChanged: new Observable<[NodeId, boolean]>(),
        nodeDecommissioned: new Observable<[NodeId]>(),
    };
    const commandHandler = {
        start: () => Promise.resolve(),
        events,
        bleEnabled: false,
        bleProxyEnabled: false,
        getNodeIds: () => [NodeId(12)],
        getNodeDetails: () => ({
            node_id: 12,
            available: true,
            is_bridge: options.isBridge ?? true,
            attributes,
            endpoint_parents: options.endpointParents ?? {},
        }),
        formatNode: (nodeId: NodeId) => String(nodeId),
        handleInvoke: (request: unknown) => {
            invoked.push(request);
            return Promise.resolve();
        },
        interviewNode: () => Promise.resolve(),
        handleWriteAttribute: (request: unknown) => {
            invoked.push(request);
            return Promise.resolve([]);
        },
    } as unknown as ControllerCommandHandler;
    const commandContext = options.withCommands
        ? {
              config: { getWifiCredentials: () => undefined, getThreadCredentials: () => undefined },
              controller: {},
          }
        : undefined;
    const bridge = new MqttBridge(
        commandHandler,
        {
            url: "mqtt://test",
            connection,
            lastSeen: options.lastSeen,
            homeAssistantDiscovery: options.homeAssistantDiscovery,
        },
        commandContext as never,
    );
    const last = (topic: string) => published.filter(p => p.topic === topic).at(-1)?.payload;
    const bridgeEvents = () =>
        published
            .filter(p => p.topic === "matter2mqtt/bridge/event")
            .map(p => JSON.parse(p.payload) as Record<string, unknown>);
    return {
        bridge,
        nodeId: NodeId(12),
        events,
        published,
        invoked,
        last,
        bridgeEvents,
        send: (topic: string, payload: string) => onMessage(topic, payload),
        /** Waits out the bridge's window for collecting attribute reports into one state publish. */
        settle: () => new Promise(resolve => setTimeout(resolve, 40)),
        setAttributes: (next: Record<string, unknown>) => {
            attributes = next;
        },
    };
}
