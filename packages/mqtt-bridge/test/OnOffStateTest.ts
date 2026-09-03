/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { onOffEndpointsOf, onOffStatePayload, onOffValueOf, parseSetCommand } from "../src/OnOffState.js";

describe("OnOffState", () => {
    describe("onOffEndpointsOf", () => {
        it("finds endpoints with the OnOff attribute", () => {
            const attributes = {
                "0/40/1": "Vendor",
                "1/6/0": true,
                "1/6/16384": false,
                "1/8/0": 128,
                "3/6/0": false,
            };
            expect(onOffEndpointsOf(attributes)).to.deep.equal([1, 3]);
        });

        it("returns an empty list without OnOff support", () => {
            expect(onOffEndpointsOf({ "0/40/1": "Vendor", "1/1026/0": 2000 })).to.deep.equal([]);
        });
    });

    describe("onOffValueOf", () => {
        const attributes = { "1/6/0": true, "2/6/0": "bogus" };

        it("returns the boolean attribute value", () => {
            expect(onOffValueOf(attributes, 1)).to.equal(true);
        });

        it("returns undefined for missing or non-boolean values", () => {
            expect(onOffValueOf(attributes, 2)).to.equal(undefined);
            expect(onOffValueOf(attributes, 3)).to.equal(undefined);
        });
    });

    describe("onOffStatePayload", () => {
        it("serializes the state", () => {
            expect(onOffStatePayload(true)).to.equal('{"state":"ON"}');
            expect(onOffStatePayload(false)).to.equal('{"state":"OFF"}');
        });
    });

    describe("parseSetCommand", () => {
        it("parses bare strings case-insensitively", () => {
            expect(parseSetCommand("ON")).to.equal("on");
            expect(parseSetCommand("off")).to.equal("off");
            expect(parseSetCommand(" Toggle ")).to.equal("toggle");
        });

        it("parses JSON objects with a state member", () => {
            expect(parseSetCommand('{"state":"ON"}')).to.equal("on");
            expect(parseSetCommand('{"state":"toggle"}')).to.equal("toggle");
            expect(parseSetCommand('{"state":false}')).to.equal("off");
        });

        it("parses JSON strings and booleans", () => {
            expect(parseSetCommand('"OFF"')).to.equal("off");
            expect(parseSetCommand("true")).to.equal("on");
            expect(parseSetCommand("false")).to.equal("off");
        });

        it("rejects unsupported payloads", () => {
            expect(parseSetCommand("")).to.equal(undefined);
            expect(parseSetCommand("42")).to.equal(undefined);
            expect(parseSetCommand('{"brightness":10}')).to.equal(undefined);
            expect(parseSetCommand("banana")).to.equal(undefined);
        });
    });
});
