/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import { Bytes } from "@matter/main";
import { Matter } from "@matter/main/model";
import { TlvOfModel } from "@matter/main/types";
import "../src/register.js";

function commandSchema(name: string) {
    const cluster = Matter.clusters.find(model => model.id === 0x120bfc01);
    const model = cluster?.commands.find(candidate => candidate.name === name);
    if (model === undefined) {
        throw new Error(`Heiman command ${name} is not registered`);
    }
    return { id: model.id, tlv: TlvOfModel(model) };
}

describe("Heiman cluster", () => {
    it("encodes the mutingSensor field with tag 0 (characterization)", () => {
        expect(Bytes.toHex(commandSchema("mutingSensor").tlv.encode({ mutingTime: 30 }))).to.equal("1524001e18");
    });

    it("refuses a mutingSensor request without mutingTime", () => {
        expect(() => commandSchema("mutingSensor").tlv.encode({})).to.throw();
    });

    it("encodes each sirenActivate field with its own tag", () => {
        const { id, tlv } = commandSchema("sirenActivate");
        expect(id).to.equal(0x01);
        expect(Bytes.toHex(tlv.encode({ sirenType: 1, volume: 50, duration: 60 }))).to.equal("1524000124013224023c18");
    });

    it("refuses a sirenActivate request without duration", () => {
        expect(() => commandSchema("sirenActivate").tlv.encode({ sirenType: 1, volume: 50 })).to.throw();
    });
});
