import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { parseJsonReply, portableSchema } from "../src/openrouter.js";

const Schema = z.object({ n: z.number().int(), items: z.array(z.object({ s: z.string() })) });

test("parses JSON wrapped in a code fence or chatter", () => {
  const reply = 'Sure! Here it is:\n```json\n{"n": 1, "items": [{"s": "a"}]}\n```';
  assert.deepEqual(parseJsonReply(reply, Schema), { n: 1, items: [{ s: "a" }] });
});

test("rejects invalid JSON and JSON of the wrong shape", () => {
  assert.throws(() => parseJsonReply("not json", Schema), /valid JSON/);
  assert.throws(() => parseJsonReply('{"n": "one", "items": []}', Schema), /wrong shape/);
});

test("portable schema drops $schema and bounds, and closes every object", () => {
  const schema = portableSchema(Schema);
  const text = JSON.stringify(schema);
  assert.ok(!text.includes("$schema") && !text.includes("minimum") && !text.includes("maximum"));
  assert.equal(schema.additionalProperties, false);
  const items = (schema.properties as Record<string, { items: { additionalProperties: boolean } }>).items;
  assert.equal(items.items.additionalProperties, false);
});
