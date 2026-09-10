/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { staleRetainedReason, type RetainedContext } from "../src/StaleTopics.js";

/** A discovery config as the bridge publishes it: its payload references our topic prefix. */
const ours = (prefix = "matter2mqtt") =>
    JSON.stringify({
        name: "Commission code",
        state_topic: `${prefix}/bridge/commission_code`,
        command_topic: `${prefix}/bridge/request/commission`,
        availability: [{ topic: `${prefix}/bridge/state` }],
    });

const context = (overrides: Partial<RetainedContext> = {}): RetainedContext => ({
    prefix: "matter2mqtt",
    expectedDiscovery: new Set(["homeassistant/sensor/matter2mqtt_bridge/version/config"]),
    knownDevices: new Set(["8", "10"]),
    ...overrides,
});

describe("staleRetainedReason", () => {
    describe("discovery configs", () => {
        it("clears an entity the bridge no longer publishes", () => {
            // The bridge card carried these before the commission-mode select replaced them
            const reason = staleRetainedReason(
                "homeassistant/text/matter2mqtt_bridge/add_wifi_device/config",
                ours(),
                context(),
            );
            expect(reason).to.contain("no longer publishes");
        });

        it("keeps an entity the bridge publishes right now", () => {
            expect(
                staleRetainedReason("homeassistant/sensor/matter2mqtt_bridge/version/config", ours(), context()),
            ).to.equal(undefined);
        });

        it("keeps a config belonging to another integration", () => {
            const zigbee2mqtt = JSON.stringify({
                state_topic: "zigbee2mqtt/0xb83dfb085bc40000",
                availability: [{ topic: "zigbee2mqtt/bridge/state" }],
            });
            expect(
                staleRetainedReason("homeassistant/update/0xb83dfb085bc40000/update/config", zigbee2mqtt, context()),
            ).to.equal(undefined);
        });

        it("does not claim a config from a bridge whose prefix merely starts like ours", () => {
            for (const other of ["matter2mqtt2", "home/matter2mqtt"]) {
                expect(
                    staleRetainedReason(
                        "homeassistant/text/matter2mqtt_bridge/commission_code/config",
                        ours(other),
                        context(),
                    ),
                    other,
                ).to.equal(undefined);
            }
        });

        it("clears a stale device entity, which per-device reconciliation cannot reach", () => {
            // Node 9 was decommissioned while the bridge was down, so nothing tracks its topics
            expect(staleRetainedReason("homeassistant/light/matter2mqtt_9/light/config", ours(), context())).to.contain(
                "no longer publishes",
            );
        });
    });

    describe("device state and availability", () => {
        it("clears the state of a device that is not commissioned", () => {
            expect(staleRetainedReason("matter2mqtt/1", '{"state":"ON"}', context())).to.contain("no such device");
            expect(staleRetainedReason("matter2mqtt/7/availability", "online", context())).to.contain("no such device");
        });

        it("keeps the state of a commissioned device", () => {
            expect(staleRetainedReason("matter2mqtt/8", '{"state":"ON"}', context())).to.equal(undefined);
            expect(staleRetainedReason("matter2mqtt/10/availability", "online", context())).to.equal(undefined);
        });

        it("never touches the bridge's own topics", () => {
            for (const topic of ["matter2mqtt/bridge", "matter2mqtt/bridge/state", "matter2mqtt/bridge/devices"]) {
                expect(staleRetainedReason(topic, '{"state":"online"}', context()), topic).to.equal(undefined);
            }
        });

        it("never touches command topics", () => {
            for (const topic of [
                "matter2mqtt/1/set",
                "matter2mqtt/1/get",
                "matter2mqtt/1/set/state",
                "matter2mqtt/1/2/set",
            ]) {
                expect(staleRetainedReason(topic, "ON", context()), topic).to.equal(undefined);
            }
        });

        it("leaves another prefix alone", () => {
            expect(staleRetainedReason("zigbee2mqtt/0x1234", '{"state":"ON"}', context())).to.equal(undefined);
        });
    });

    it("ignores an empty payload, which is a clear rather than content", () => {
        expect(staleRetainedReason("matter2mqtt/1", "", context())).to.equal(undefined);
        expect(staleRetainedReason("homeassistant/text/matter2mqtt_bridge/gone/config", "  ", context())).to.equal(
            undefined,
        );
    });
});
