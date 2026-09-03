/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Logger } from "@matter/main";
import { connect, type MqttClient } from "mqtt";

const logger = Logger.get("MqttConnection");

const SUPPORTED_PROTOCOLS = ["mqtt:", "mqtts:", "ws:", "wss:"];

export interface MqttConnectionOptions {
    /** Broker URL, e.g. `mqtt://user:password@localhost:1883`. */
    url: string;
    clientId: string;
    /** Last-will message, published retained by the broker on unexpected disconnect. */
    will: { topic: string; payload: string };
}

export type MessageHandler = (topic: string, payload: string) => void;

/**
 * Thin wrapper around MQTT.js for the bridge's needs: fire-and-forget publishes with
 * error logging, subscription fan-in to a single handler, and a graceful close that
 * replaces the last-will with an explicit offline message.
 *
 * Connection management is left to MQTT.js: it retries the initial connect, reconnects
 * with backoff, and queues outbound packets while offline. `connect()` therefore returns
 * immediately and the bridge never blocks server startup on broker availability.
 */
export class MqttConnection {
    readonly #options: MqttConnectionOptions;
    #client?: MqttClient;

    constructor(options: MqttConnectionOptions) {
        const { protocol } = new URL(options.url);
        if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
            throw new Error(
                `Unsupported MQTT broker protocol "${protocol}": expected one of ${SUPPORTED_PROTOCOLS.join(", ")}`,
            );
        }
        this.#options = options;
    }

    get connected(): boolean {
        return this.#client?.connected ?? false;
    }

    connect(onMessage: MessageHandler): void {
        if (this.#client !== undefined) {
            throw new Error("MQTT connection already started");
        }

        const { url, clientId, will } = this.#options;
        const client = connect(url, {
            clientId,
            will: { topic: will.topic, payload: Buffer.from(will.payload), retain: true, qos: 1 },
        });
        this.#client = client;

        client.on("connect", () => logger.notice(`Connected to MQTT broker at ${this.#redactedUrl()}`));
        client.on("reconnect", () => logger.debug("Reconnecting to MQTT broker"));
        client.on("offline", () => logger.warn("MQTT broker connection lost, queueing messages"));
        client.on("error", error => logger.warn(`MQTT connection error: ${error.message}`));
        client.on("message", (topic, payload) => {
            // Fan-in point for all subscriptions; a throwing handler would hit MQTT.js internals
            try {
                onMessage(topic, payload.toString());
            } catch (error) {
                logger.error(`Unhandled error processing MQTT message on ${topic}:`, error);
            }
        });
    }

    subscribe(filters: string[]): void {
        this.#requireClient().subscribe(filters, (error: Error | null) => {
            if (error) {
                logger.error(`Failed to subscribe to ${filters.join(", ")}:`, error);
            }
        });
    }

    /** Publish without awaiting; failures are logged. QoS 0. */
    publish(topic: string, payload: string, retain = false): void {
        this.#requireClient().publish(topic, payload, { retain }, (error?: Error) => {
            if (error) {
                logger.warn(`Failed to publish to ${topic}:`, error);
            }
        });
    }

    #requireClient(): MqttClient {
        if (this.#client === undefined) {
            throw new Error("MQTT connection not started");
        }
        return this.#client;
    }

    /** Clear a retained topic by publishing an empty payload. */
    clearRetained(topic: string): void {
        this.publish(topic, "", true);
    }

    /** Publish the final message (if currently connected) and disconnect. */
    async close(finalMessage?: { topic: string; payload: string }): Promise<void> {
        const client = this.#client;
        if (client === undefined) {
            return;
        }
        this.#client = undefined;
        if (finalMessage !== undefined && client.connected) {
            try {
                await client.publishAsync(finalMessage.topic, finalMessage.payload, { retain: true });
            } catch (error) {
                logger.warn("Failed to publish offline state on shutdown:", error);
            }
        }
        await client.endAsync();
        logger.info("Disconnected from MQTT broker");
    }

    /** Broker URL without credentials, for logging. */
    #redactedUrl(): string {
        const url = new URL(this.#options.url);
        url.username = "";
        url.password = "";
        return url.toString();
    }
}
