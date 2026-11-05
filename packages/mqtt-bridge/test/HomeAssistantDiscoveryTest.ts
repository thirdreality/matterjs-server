/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { harness } from "./BridgeHarness.js";

const BULB = { "1/6/0": true, "1/8/0": 100 };
const isDiscovery = (topic: string) => topic.startsWith("homeassistant/");

describe("Home Assistant discovery switch", () => {
    it("announces the bridge and its devices by default", async () => {
        const h = harness(BULB, { isBridge: false });
        await h.bridge.start();
        const announced = h.published.filter(p => isDiscovery(p.topic) && p.payload !== "").map(p => p.topic);
        expect(announced).to.include("homeassistant/light/matter2mqtt_12/light/config");
        expect(announced.some(topic => topic.includes("matter2mqtt_bridge"))).to.equal(true);
        await h.bridge.stop();
    });

    it("announces nothing when off, while state and commands keep working", async () => {
        const h = harness(BULB, { isBridge: false, homeAssistantDiscovery: false });
        await h.bridge.start();
        expect(h.published.filter(p => isDiscovery(p.topic) && p.payload !== "")).to.deep.equal([]);
        expect(JSON.parse(h.last("matter2mqtt/12") ?? "{}")).to.deep.equal({ state: "ON", brightness: 100 });
        h.send("matter2mqtt/12/set", "OFF");
        expect(h.invoked).to.have.length(1);
        await h.bridge.stop();
    });

    it("clears the discovery a previous run left on the broker", async () => {
        const h = harness(BULB, { isBridge: false, homeAssistantDiscovery: false });
        await h.bridge.start();
        h.send("homeassistant/light/matter2mqtt_12/light/config", '{"state_topic":"matter2mqtt/12"}');
        h.send("homeassistant/sensor/matter2mqtt_bridge/version/config", '{"state_topic":"matter2mqtt/bridge/info"}');
        expect(h.last("homeassistant/light/matter2mqtt_12/light/config")).to.equal("");
        expect(h.last("homeassistant/sensor/matter2mqtt_bridge/version/config")).to.equal("");
        await h.bridge.stop();
    });

    it("announces no group entity when off", async () => {
        const h = harness(BULB, { isBridge: false, homeAssistantDiscovery: false, withCommands: true });
        await h.bridge.start();
        h.send("matter2mqtt/bridge/request/group/add", "hall");
        await new Promise(resolve => setImmediate(resolve));
        h.send("matter2mqtt/bridge/request/group/members/add", '{"group":"hall","device":"12"}');
        await new Promise(resolve => setImmediate(resolve));
        expect(h.published.filter(p => isDiscovery(p.topic) && p.payload !== "")).to.deep.equal([]);
        expect(JSON.parse(h.last("matter2mqtt/hall") ?? "{}").state).to.equal("ON");
        await h.bridge.stop();
    });
});
