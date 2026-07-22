import test from "node:test";
import assert from "node:assert/strict";

import { parseProtocolLine } from "./sidecar.mjs";

test("parseProtocolLine accepts versioned responses and events", () => {
  assert.deepEqual(parseProtocolLine('{"protocol":1,"id":7,"ok":true,"result":{}}'), {
    type: "response",
    envelope: { protocol: 1, id: 7, ok: true, result: {} }
  });
  assert.deepEqual(parseProtocolLine('{"protocol":1,"event":"status","data":{}}'), {
    type: "event",
    envelope: { protocol: 1, event: "status", data: {} }
  });
});

test("parseProtocolLine fails closed on malformed or unversioned input", () => {
  assert.throws(() => parseProtocolLine("not-json"));
  assert.throws(() => parseProtocolLine('{"protocol":2,"event":"status"}'));
  assert.throws(() => parseProtocolLine('{"protocol":1,"id":0,"ok":true}'));
  assert.throws(() => parseProtocolLine('{"protocol":1,"data":{}}'));
});
