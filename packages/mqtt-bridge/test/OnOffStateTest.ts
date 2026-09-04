/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { onOffEndpointsOf, onOffStatePayload, onOffValueOf } from "../src/OnOffState.js";

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
});
