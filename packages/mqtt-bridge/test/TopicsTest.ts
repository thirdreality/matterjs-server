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

        it("provides command subscription filters", () => {
            expect(topics.commandFilters).to.deep.equal([
                "matter2mqtt/+/set",
                "matter2mqtt/+/+/set",
                "matter2mqtt/+/set/+",
                "matter2mqtt/+/+/set/+",
                "matter2mqtt/+/get",
                "matter2mqtt/+/+/get",
            ]);
        });
    });

    describe("parseInbound", () => {
        it("parses a device set topic", () => {
            expect(topics.parseInbound("matter2mqtt/5/set")).to.deep.equal({
                device: "5",
                kind: "set",
                attribute: undefined,
            });
        });

        it("parses an endpoint set topic", () => {
            expect(topics.parseInbound("matter2mqtt/5/2/set")).to.deep.equal({
                device: "5",
                endpoint: 2,
                kind: "set",
                attribute: undefined,
            });
        });

        it("parses set/<attribute> topics", () => {
            expect(topics.parseInbound("matter2mqtt/5/set/state")).to.deep.equal({
                device: "5",
                kind: "set",
                attribute: "state",
            });
            expect(topics.parseInbound("matter2mqtt/5/2/set/state")).to.deep.equal({
                device: "5",
                endpoint: 2,
                kind: "set",
                attribute: "state",
            });
            expect(topics.parseInbound("matter2mqtt/5/set/brightness")).to.deep.equal({
                device: "5",
                kind: "set",
                attribute: "brightness",
            });
        });

        it("parses get topics", () => {
            expect(topics.parseInbound("matter2mqtt/5/get")).to.deep.equal({
                device: "5",
                kind: "get",
                attribute: undefined,
            });
            expect(topics.parseInbound("matter2mqtt/5/2/get")).to.deep.equal({
                device: "5",
                endpoint: 2,
                kind: "get",
                attribute: undefined,
            });
        });

        it("rejects non-command and bridge topics", () => {
            expect(topics.parseInbound("matter2mqtt/5")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/bridge/set")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/bridge/get")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/bridge/set/state")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/5/x/set")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/5/2/3/set")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/5/x/get")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/5/2/3/set/state")).to.equal(undefined);
            expect(topics.parseInbound("other/5/set")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt//set")).to.equal(undefined);
            expect(topics.parseInbound("matter2mqtt/5/get/state")).to.equal(undefined);
        });
    });
});
