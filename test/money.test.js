import test from "node:test";
import assert from "node:assert/strict";
import { toUnits, fromUnits, invoiceTotal, group, canonical } from "../web/lib.js";

test("toUnits / fromUnits round-trip exactly", () => {
  assert.equal(toUnits("12.5"), "12500000");
  assert.equal(toUnits("0.000001"), "1");
  assert.equal(fromUnits("12500000"), "12.50");
  assert.equal(fromUnits("1"), "0.000001");
  assert.equal(fromUnits("1000000"), "1.00");
});

test("toUnits rejects bad input", () => {
  for (const bad of ["", "-1", "1e3", "1.1234567", "abc", "1,5"]) assert.throws(() => toUnits(bad), bad);
});

test("invoiceTotal handles fractional quantities without float drift", () => {
  const total = invoiceTotal([{ qty: "7.5", unit_price: "60" }, { qty: "1", unit_price: "400" }]);
  assert.equal(fromUnits(total), "850.00");
  assert.equal(fromUnits(invoiceTotal([{ qty: "3", unit_price: "0.1" }])), "0.30");
});

test("group formats thousands", () => {
  assert.equal(group("1234567.50"), "1,234,567.50");
});

test("canonical is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), canonical({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
});
