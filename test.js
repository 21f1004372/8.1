const assert = require('assert');
const { parseAndNormalizeDate, canonicalizeText, calculateCrc32c, getWordSet, calculateJaccardSimilarity } = require('./utils');
const { processCorpus } = require('./corpus');

console.log('Starting unit tests...');

// 1. Date normalization test
assert.strictEqual(parseAndNormalizeDate("2026-01-02T05:30:00+05:30"), "2026-01-02T00:00:00.000Z");
assert.strictEqual(parseAndNormalizeDate("2026-01-02T00:00:00.12Z"), "2026-01-02T00:00:00.120Z");
assert.strictEqual(parseAndNormalizeDate("2026-01-02T00:00:00.1Z"), "2026-01-02T00:00:00.100Z");
assert.strictEqual(parseAndNormalizeDate("2026-02-29T00:00:00Z"), null); // 2026 is not a leap year
assert.strictEqual(parseAndNormalizeDate("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00.000Z"); // 2024 is a leap year
assert.strictEqual(parseAndNormalizeDate("2026-01-02T00:00:00+14:00"), "2026-01-01T10:00:00.000Z");
assert.strictEqual(parseAndNormalizeDate("2026-01-02T00:00:00+14:01"), null); // offset > 14:00
assert.strictEqual(parseAndNormalizeDate("2026-01-02T00:00:00-14:00"), "2026-01-02T14:00:00.000Z");
console.log('✓ Date parsing & normalization tests passed.');

// 2. CRC32C test
assert.strictEqual(calculateCrc32c(Buffer.from("hello world", "utf8")), "c99465aa");
console.log('✓ CRC32C computation tests passed.');

// 3. Text Canonicalization test
assert.strictEqual(canonicalizeText("  Hello \u2000 World  \n"), "hello world");
console.log('✓ Unicode text canonicalization tests passed.');

// 4. Jaccard similarity
const setA = getWordSet("hello world 123");
const setB = getWordSet("hello 123");
const sim = calculateJaccardSimilarity(setA, setB);
assert.strictEqual(sim, 2/3);
console.log('✓ Jaccard similarity tests passed.');

// 5. Object Rejection Tests - Multiple errors & Independent JSONL/SCHEMA check
const payloadWithObjErrors = {
  policy: {
    minTime: "2026-01-01T00:00:00Z",
    maxTime: "2026-01-10T00:00:00Z",
    contaminationThreshold: 0.8
  },
  objects: [
    {
      uri: "invalid-uri",
      generation: "abc",
      fetchedGeneration: "def",
      crc32c: "xyz",
      schemaId: "training-v2",
      content: "not valid jsonl\n" + JSON.stringify({ id: "row-1", entity: "A", eventTime: "2026-01-02T12:00:00Z", revision: -1, text: "invalid-schema" })
    }
  ]
};

const resultObjErrors = processCorpus(payloadWithObjErrors);
assert.strictEqual(resultObjErrors.rejectedObjects.length, 1);
const rejectedCodes = resultObjErrors.rejectedObjects[0].reasonCodes;
// Must contain URI_INVALID, GENERATION_INVALID, GENERATION_MISMATCH, CRC32C_INVALID, SCHEMA_INVALID, JSONL_INVALID
assert.ok(rejectedCodes.includes('URI_INVALID'));
assert.ok(rejectedCodes.includes('GENERATION_INVALID'));
assert.ok(rejectedCodes.includes('GENERATION_MISMATCH'));
assert.ok(rejectedCodes.includes('CRC32C_INVALID'));
assert.ok(rejectedCodes.includes('SCHEMA_INVALID'));
assert.ok(rejectedCodes.includes('JSONL_INVALID'));
console.log('✓ Object rejection validation tests (including independent JSONL & SCHEMA) passed.');

// 6. Deduplication and tie-breaking test
const deduplicationPayload = {
  policy: {
    minTime: "2026-01-01T00:00:00Z",
    maxTime: "2026-01-10T00:00:00Z",
    contaminationThreshold: 0.8
  },
  objects: [
    {
      uri: "gs://bucket/data",
      generation: "123",
      fetchedGeneration: "123",
      crc32c: "",
      schemaId: "training-v1",
      content: [
        JSON.stringify({ id: "row-1", entity: "A", eventTime: "2026-01-02T12:00:00Z", revision: 1, text: "hello" }),
        JSON.stringify({ id: "row-2", entity: "A", eventTime: "2026-01-02T12:00:00Z", revision: 2, text: "hello" }),
        JSON.stringify({ id: "row-3", entity: "B", eventTime: "2026-01-02T12:00:00Z", revision: 1, text: "world" }),
        JSON.stringify({ id: "row-4", entity: "B", eventTime: "2026-01-02T12:00:00Z", revision: 1, text: "world" })
      ].join('\n')
    }
  ]
};
deduplicationPayload.objects[0].crc32c = calculateCrc32c(Buffer.from(deduplicationPayload.objects[0].content, 'utf8'));

const dedupResult = processCorpus(deduplicationPayload);
assert.strictEqual(dedupResult.rejectedRows.length, 2);
assert.deepStrictEqual(dedupResult.rejectedRows[0], { id: "row-1", reasonCodes: ["DUPLICATE"] });
assert.deepStrictEqual(dedupResult.rejectedRows[1], { id: "row-4", reasonCodes: ["DUPLICATE"] });
console.log('✓ Deduplication and tie-breaking tests passed.');

// 7. Policy validity and window tests
const invalidPolicyPayload = {
  policy: {
    minTime: "2026-01-01T00:00:00Z",
    maxTime: "invalid-date",
    contaminationThreshold: 0.8
  },
  objects: [
    {
      uri: "gs://bucket/data",
      generation: "123",
      fetchedGeneration: "123",
      crc32c: "",
      schemaId: "training-v1",
      content: JSON.stringify({ id: "row-1", entity: "A", eventTime: "2026-01-02T12:00:00Z", revision: 1, text: "hello" })
    }
  ]
};
invalidPolicyPayload.objects[0].crc32c = calculateCrc32c(Buffer.from(invalidPolicyPayload.objects[0].content, 'utf8'));

const invalidPolicyResult = processCorpus(invalidPolicyPayload);
assert.strictEqual(invalidPolicyResult.rejectedRows.length, 1);
assert.deepStrictEqual(invalidPolicyResult.rejectedRows[0], { id: "row-1", reasonCodes: ["POLICY_INVALID"] });
console.log('✓ Invalid policy rejection tests passed.');

console.log('All tests completed successfully!');
