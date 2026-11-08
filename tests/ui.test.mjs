import test from "node:test";
import assert from "node:assert/strict";
import { validateReceiver } from "../src/ui.js";

const receiver = { ip: "192.168.1.42", port: 53612, code: "012345" };

test("accepts discovered addresses, hostnames and explicitly bracketed IPv6", () => {
  for (const ip of [receiver.ip, "receiver.local", "[::1]"]) {
    assert.deepEqual(validateReceiver({ ...receiver, ip }), {});
  }
});

test("identifies each missing field for inline errors and the linked summary", () => {
  const errors = validateReceiver({ ip: "", port: 0, code: "" });
  assert.deepEqual(Object.keys(errors), ["peer-ip", "peer-port", "peer-code"]);
});

test("rejects malformed addresses and addresses containing request components", () => {
  for (const ip of ["999.1.1.1", "192.168.1.42:80", "user@receiver.local", "receiver.local/path", "receiver.local?code=bad", "receiver.local#fragment", "receiver local"]) {
    assert.ok(validateReceiver({ ...receiver, ip })["peer-ip"], ip);
  }
});

test("validates port bounds without silently accepting fractions or NaN", () => {
  for (const port of [0, -1, 65536, 1.5, NaN]) {
    assert.ok(validateReceiver({ ...receiver, port })["peer-port"]);
  }
  for (const port of [1, 65535]) assert.deepEqual(validateReceiver({ ...receiver, port }), {});
});

test("requires six digits and preserves leading zeroes in the pairing code", () => {
  for (const code of ["", "12345", "1234567", "abcdef", "12 345"]) {
    assert.ok(validateReceiver({ ...receiver, code })["peer-code"]);
  }
  assert.deepEqual(validateReceiver({ ...receiver, code: "000001" }), {});
});
