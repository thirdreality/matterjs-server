/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    toBigIntAwareJson,
    type AttributesData,
    type ControllerCommandHandler,
    type MatterNodeData,
} from "@matter-server/ws-controller";
import { Logger, NodeId, ObserverGroup } from "@matter/main";
import { ClusterId, EndpointNumber } from "@matter/main/types";
import { lightCapabilitiesOf } from "./LightCapabilities.js";
import { MqttConnection } from "./MqttConnection.js";
import { ONOFF_CLUSTER_ID, onOffEndpointsOf, onOffStatePayload, onOffValueOf } from "./OnOffState.js";
import { parseSetMessage } from "./SetCommands.js";
import { Topics } from "./Topics.js";

const logger = Logger.get("MqttBridge");

/** zigbee2mqtt-style bridge state payload: `{"state":"online"}`. */
function bridgeStatePayload(state: "online" | "offline"): string {
    return JSON.stringify({ state });
}

export interface MqttBridgeOptions {
    /** Broker URL, e.g. `mqtt://user:password@localhost:1883`. */
    url: string;
    /** Topic prefix. Default: `matter2mqtt`. */
    prefix?: string;
    /** MQTT client id. Default: `matter2mqtt`. */
    clientId?: string;
    /** Server version, published in `bridge/info`. */
    serverVersion?: string;
}

interface DeviceEntry {
    nodeId: NodeId;
    onOffEndpoints: number[];
}

/**
 * MQTT bridge (matter2mqtt): publishes Matter device state to an MQTT broker and routes
 * inbound MQTT commands to the {@link ControllerCommandHandler}, following a
 * zigbee2mqtt-style topic layout (see package README).
 *
 * The bridge is an additional consumer of the controller's shared event hub, alongside
 * the WebSocket handler; it never blocks or alters existing server functionality.
 */
export class MqttBridge {
    readonly #commandHandler: ControllerCommandHandler;
    readonly #topics: Topics;
    readonly #connection: MqttConnection;
    readonly #serverVersion?: string;
    readonly #observers = new ObserverGroup();
    /** Known devices keyed by node id string (the `<device>` topic segment). */
    readonly #devices = new Map<string, DeviceEntry>();
    #started = false;

    constructor(commandHandler: ControllerCommandHandler, options: MqttBridgeOptions) {
        this.#commandHandler = commandHandler;
        this.#serverVersion = options.serverVersion;
        this.#topics = new Topics(options.prefix ?? "matter2mqtt");
        this.#connection = new MqttConnection({
            url: options.url,
            clientId: options.clientId ?? "matter2mqtt",
            will: { topic: this.#topics.bridgeState, payload: bridgeStatePayload("offline") },
        });
    }

    async start(): Promise<void> {
        if (this.#started) {
            return;
        }
        this.#started = true;

        this.#connection.connect((topic, payload) => this.#handleMessage(topic, payload));
        this.#connection.subscribe(this.#topics.commandFilters);

        // The Matter stack is otherwise only started once a WebSocket client connects
        await this.#commandHandler.start();

        const { events } = this.#commandHandler;

        // Shared Observables: an uncaught throw would abort the emit and starve other consumers
        this.#observers.on(events.attributeChanged, (nodeId, data) => {
            try {
                this.#handleAttributeChanged(nodeId, data.path, data.value);
            } catch (error) {
                logger.warn(`Failed to publish attribute change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAdded, nodeId => {
            try {
                this.#refreshDevice(nodeId);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish added node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeStructureChanged, nodeId => {
            try {
                this.#refreshDevice(nodeId);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish structure change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAvailabilityChanged, (nodeId, available) => {
            try {
                this.#connection.publish(
                    this.#topics.deviceAvailability(nodeId.toString()),
                    available ? "online" : "offline",
                    true,
                );
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish availability for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeDecommissioned, nodeId => {
            try {
                this.#removeDevice(nodeId.toString());
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to clear topics for removed node ${nodeId}:`, error);
            }
        });

        for (const nodeId of this.#commandHandler.getNodeIds()) {
            try {
                this.#refreshDevice(nodeId);
            } catch (error) {
                logger.warn(`Failed to publish initial state for node ${nodeId}:`, error);
            }
        }
        this.#publishDevices();
        this.#publishBridgeInfo();
        this.#connection.publish(this.#topics.bridgeState, bridgeStatePayload("online"), true);

        logger.notice(`MQTT bridge started with prefix "${this.#topics.prefix}"`);
    }

    async stop(): Promise<void> {
        if (!this.#started) {
            return;
        }
        this.#started = false;
        this.#observers.close();
        await this.#connection.close({ topic: this.#topics.bridgeState, payload: bridgeStatePayload("offline") });
    }

    #handleAttributeChanged(
        nodeId: NodeId,
        path: { endpointId: number; clusterId: number; attributeId: number },
        value: unknown,
    ): void {
        if (path.clusterId !== ONOFF_CLUSTER_ID || path.attributeId !== 0 || typeof value !== "boolean") {
            return;
        }
        const device = nodeId.toString();
        let entry = this.#devices.get(device);
        if (entry === undefined || !entry.onOffEndpoints.includes(path.endpointId)) {
            // Unknown device or endpoint: the structure changed ahead of any structure event
            entry = this.#refreshDevice(nodeId);
            this.#publishDevices();
            if (entry === undefined || !entry.onOffEndpoints.includes(path.endpointId)) {
                return;
            }
        }
        this.#publishOnOffState(entry, path.endpointId, value);
    }

    #handleMessage(topic: string, payload: string): void {
        const parsed = this.#topics.parseInbound(topic);
        if (parsed === undefined) {
            return;
        }
        const entry = this.#devices.get(parsed.device);
        if (entry === undefined) {
            logger.warn(`Ignoring command for unknown device "${parsed.device}"`);
            return;
        }
        if (parsed.kind === "get") {
            this.#handleGet(entry, parsed.endpoint);
            return;
        }
        const endpoint = parsed.endpoint ?? entry.onOffEndpoints[0];
        if (endpoint === undefined || !entry.onOffEndpoints.includes(endpoint)) {
            logger.warn(`Device "${parsed.device}" has no OnOff support on endpoint ${endpoint ?? "(none)"}`);
            return;
        }

        let attributes;
        try {
            attributes = this.#commandHandler.getNodeDetails(entry.nodeId).attributes;
        } catch {
            logger.warn(`Cannot resolve capabilities for "${parsed.device}"`);
            return;
        }
        const caps = lightCapabilitiesOf(attributes, endpoint);
        const result = parseSetMessage(payload, parsed.attribute, caps, onOffValueOf(attributes, endpoint));
        if (result === undefined) {
            logger.warn(`Ignoring unsupported set payload for "${parsed.device}": ${payload}`);
            return;
        }
        for (const warning of result.warnings) {
            logger.warn(`Set for "${parsed.device}": ${warning}`);
        }
        void this.#runCommands(entry, endpoint, result.commands);
    }

    /** Execute parsed set commands in order; a failing command is logged and does not stop the rest. */
    async #runCommands(
        entry: DeviceEntry,
        endpoint: number,
        commands: { clusterId: number; commandName: string; data: Record<string, unknown> }[],
    ): Promise<void> {
        const node = this.#commandHandler.formatNode(entry.nodeId);
        for (const command of commands) {
            logger.info(`MQTT command for node ${node}/${endpoint}: ${command.commandName}`);
            try {
                await this.#commandHandler.handleInvoke({
                    nodeId: entry.nodeId,
                    endpointId: EndpointNumber(endpoint),
                    clusterId: ClusterId(command.clusterId),
                    commandName: command.commandName,
                    data: command.data,
                });
            } catch (error) {
                logger.warn(`Command "${command.commandName}" failed for node ${node}:`, error);
            }
        }
    }

    /** zigbee2mqtt-style `get`: re-publish the current state from the attribute cache. */
    #handleGet(entry: DeviceEntry, endpoint?: number): void {
        const device = entry.nodeId.toString();
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(entry.nodeId);
        } catch {
            logger.warn(`Cannot read state for get request on "${device}"`);
            return;
        }
        const endpoints = endpoint === undefined ? entry.onOffEndpoints : [endpoint];
        for (const ep of endpoints) {
            if (!entry.onOffEndpoints.includes(ep)) {
                logger.warn(`Device "${device}" has no OnOff support on endpoint ${ep}`);
                continue;
            }
            const value = onOffValueOf(details.attributes, ep);
            if (value !== undefined) {
                this.#publishOnOffState(entry, ep, value);
            }
        }
    }

    /**
     * (Re-)sync a device from the controller's attribute cache: track its OnOff endpoints
     * and publish availability and current state. Returns undefined if the node is gone.
     */
    #refreshDevice(nodeId: NodeId): DeviceEntry | undefined {
        const device = nodeId.toString();

        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(nodeId);
        } catch {
            this.#removeDevice(device);
            return undefined;
        }

        const onOffEndpoints = onOffEndpointsOf(details.attributes);
        const previous = this.#devices.get(device);
        const entry: DeviceEntry = { nodeId, onOffEndpoints };
        this.#devices.set(device, entry);

        // The single/multi endpoint topic layout may change with the endpoint list; clear
        // retained state at the previous locations so no stale topic survives
        if (previous !== undefined && !sameLayout(previous.onOffEndpoints, onOffEndpoints)) {
            this.#clearStateTopics(device, previous.onOffEndpoints);
        }

        this.#connection.publish(
            this.#topics.deviceAvailability(device),
            details.available ? "online" : "offline",
            true,
        );
        for (const endpoint of onOffEndpoints) {
            const value = onOffValueOf(details.attributes, endpoint);
            if (value !== undefined) {
                this.#publishOnOffState(entry, endpoint, value);
            }
        }
        return entry;
    }

    #removeDevice(device: string): void {
        const entry = this.#devices.get(device);
        if (entry === undefined) {
            return;
        }
        this.#devices.delete(device);
        this.#clearStateTopics(device, entry.onOffEndpoints);
        this.#connection.clearRetained(this.#topics.deviceAvailability(device));
    }

    #publishOnOffState(entry: DeviceEntry, endpoint: number, on: boolean): void {
        const device = entry.nodeId.toString();
        const topic =
            entry.onOffEndpoints.length <= 1
                ? this.#topics.deviceState(device)
                : this.#topics.deviceState(device, endpoint);
        this.#connection.publish(topic, onOffStatePayload(on), true);
    }

    #clearStateTopics(device: string, endpoints: number[]): void {
        this.#connection.clearRetained(this.#topics.deviceState(device));
        for (const endpoint of endpoints) {
            this.#connection.clearRetained(this.#topics.deviceState(device, endpoint));
        }
    }

    #publishDevices(): void {
        const devices = this.#commandHandler.getNodeIds().map(nodeId => {
            const details = this.#commandHandler.getNodeDetails(nodeId);
            const { attributes } = details;
            return {
                id: nodeId.toString(),
                node_id: details.node_id,
                available: details.available,
                is_bridge: details.is_bridge,
                vendor_name: stringAttribute(attributes, "0/40/1"),
                product_name: stringAttribute(attributes, "0/40/3"),
                node_label: stringAttribute(attributes, "0/40/5"),
                serial_number: stringAttribute(attributes, "0/40/15"),
                unique_id: stringAttribute(attributes, "0/40/18"),
                onoff_endpoints: this.#devices.get(nodeId.toString())?.onOffEndpoints ?? [],
            };
        });
        this.#connection.publish(this.#topics.bridgeDevices, toBigIntAwareJson(devices), true);
    }

    #publishBridgeInfo(): void {
        this.#connection.publish(
            this.#topics.bridgeInfo,
            JSON.stringify({
                version: this.#serverVersion,
                ble_enabled: this.#commandHandler.bleEnabled,
                ble_proxy_enabled: this.#commandHandler.bleProxyEnabled,
                prefix: this.#topics.prefix,
            }),
            true,
        );
    }
}

function sameLayout(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stringAttribute(attributes: AttributesData, path: string): string | undefined {
    const value = attributes[path];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
