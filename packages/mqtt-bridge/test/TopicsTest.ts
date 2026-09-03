/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Topics } from "../src/Topics.js";

describe("Topics", () => {
    const topics = new Topics("matter2mqtt");

    describe("construction", () => {
        it("rejects prefixes with wildcards or empty values", () => {
            expect(() => new Topics("")).to.throw();
            expect(() => new Topics("a/+/b")).to.throw();
            expect(() => new Topics("a#")).to.throw();
            expect(() => new Topics("a b")).to.throw();
            expect(() => new Topics("a/")).to.throw();
            expect(() => new Topics("/a")).to.throw();
        });

        it("accepts multi-level prefixes", () => {
            expect(new Topics("home/matter").deviceState("5")).to.equal("home/matter/5");
        });
    });

    describe("topic building", () => {
        it("builds bridge topics", () => {
            expect(topics.bridgeState).to.equal("matter2mqtt/bridge/state");
            expect(topics.bridgeInfo).to.equal("matter2mqtt/bridge/info");
            expect(topics.bridgeDevices).to.equal("matter2mqtt/bridge/devices");
        });

        it("builds device topics", () => {
            expect(topics.deviceState("5")).to.equal("matter2mqtt/5");
            expect(topics.deviceState("5", 2)).to.equal("matter2mqtt/5/2");
            expect(topics.deviceAvailability("5")).to.equal("matter2mqtt/5/availability");
        });

        it("provides set subscription filters", () => {
            expect(topics.setFilters).to.deep.equal(["matter2mqtt/+/set", "matter2mqtt/+/+/set"]);
        });
    });

    describe("parseSetTopic", () => {
        it("parses a device set topic", () => {
            expect(topics.parseSetTopic("matter2mqtt/5/set")).to.deep.equal({ device: "5" });
        });

        it("parses an endpoint set topic", () => {
            expect(topics.parseSetTopic("matter2mqtt/5/2/set")).to.deep.equal({ device: "5", endpoint: 2 });
        });

        it("rejects non-set and bridge topics", () => {
            expect(topics.parseSetTopic("matter2mqtt/5")).to.equal(undefined);
            expect(topics.parseSetTopic("matter2mqtt/bridge/set")).to.equal(undefined);
            expect(topics.parseSetTopic("matter2mqtt/5/x/set")).to.equal(undefined);
            expect(topics.parseSetTopic("matter2mqtt/5/2/3/set")).to.equal(undefined);
            expect(topics.parseSetTopic("other/5/set")).to.equal(undefined);
            expect(topics.parseSetTopic("matter2mqtt//set")).to.equal(undefined);
        });
    });
});
