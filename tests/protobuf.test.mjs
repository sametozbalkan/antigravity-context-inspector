/**
 * Unit tests for minimal wire-level protobuf decoding (`lib/protobuf.mjs`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Msg, encodeVarint, iterFields, readVarint } from '../sidecars/inspector/lib/protobuf.mjs';
import { concatBytes, pbBytes, pbStr, pbVarint } from './helpers.mjs';

describe('TestProtobuf', () => {
  it('test_roundtrip_fields', () => {
    const raw = concatBytes(pbVarint(1, 42), pbStr(2, 'hello'), pbBytes(3, pbVarint(1, 99)));
    const msg = new Msg(raw);
    assert.equal(msg.int(1), 42);
    assert.equal(msg.str(2), 'hello');
    const nested = msg.msg(3);
    assert.notEqual(nested, null);
    assert.equal(nested.int(1), 99);
  });

  it('test_varint_bounds_and_non_bytes_guards', () => {
    // 10-byte valid 64-bit unsigned varint (e.g. -1 as uint64)
    const maxU64 = (1n << 64n) - 1n;
    const neg1Bytes = encodeVarint(maxU64);
    assert.equal(neg1Bytes.length, 10);
    const [val, pos] = readVarint(neg1Bytes, 0);
    assert.equal(val, maxU64);
    assert.equal(pos, 10);

    // >10-byte varint raises overflow
    const over11 = new Uint8Array(11).fill(0x80);
    over11[10] = 0x01;
    assert.throws(() => readVarint(over11, 0), Error);
    assert.throws(() => readVarint(new Uint8Array(10).fill(0x80), 0), Error);

    // Negative encodeVarint rejected
    assert.throws(() => encodeVarint(-1), RangeError);
    assert.throws(() => encodeVarint(-1n), RangeError);

    // Non-Uint8Array inputs handled cleanly by Msg and iterFields
    for (const bad of [null, undefined, 123, 'not-bytes', []]) {
      assert.equal(new Msg(bad).fields.size, 0);
      assert.deepEqual([...iterFields(bad)], []);
    }

    // Buffer and Uint8Array views (including non-zero byteOffset) work cleanly with Msg
    const raw = pbStr(2, 'ok');
    assert.equal(new Msg(Buffer.from(raw)).str(2), 'ok');
    const padded = new Uint8Array(raw.length + 4);
    padded.set(raw, 2);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 2, raw.length);
    assert.equal(new Msg(view).str(2), 'ok');
  });
});
