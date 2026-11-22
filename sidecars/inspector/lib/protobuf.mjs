/**
 * Minimal zero-dependency protobuf wire decoder.
 */

export const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

export function utf8ByteLength(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

/**
 * Decode an unsigned base-128 varint starting at pos.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {[bigint, number]}
 */
export function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  const len = buf.length;
  while (pos < len) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [val, pos];
    }
    shift += 7n;
    if (shift >= 70n) {
      throw new Error('Varint overflow');
    }
  }
  throw new Error('Truncated varint');
}

/**
 * Encode a non-negative integer as a base-128 varint.
 * @param {number | bigint} n
 * @returns {Uint8Array}
 */
export function encodeVarint(n) {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) {
    throw new RangeError('Varint must be non-negative');
  }
  const out = [];
  while (true) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      out.push(b | 0x80);
    } else {
      out.push(b);
      return new Uint8Array(out);
    }
  }
}

/**
 * Stream wire fields, skipping unwanted fields with zero slice copies.
 * @param {Uint8Array} buf
 * @param {Set<number> | null} [want=null]
 * @returns {Generator<[number, bigint | Uint8Array], void, void>}
 */
export function* iterFields(buf, want = null) {
  if (!(buf instanceof Uint8Array)) {
    return;
  }
  let pos = 0;
  const n = buf.length;
  while (pos < n) {
    let fn;
    let val;
    let keep;
    try {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const fnBig = tag >> 3n;
      const wt = Number(tag & 7n);
      if (fnBig === 0n) {
        break;
      }
      fn = Number(fnBig);
      keep = want == null || want.has(fn);
      if (wt === 0) {
        [val, pos] = readVarint(buf, pos);
      } else if (wt === 2) {
        let lnBig;
        [lnBig, pos] = readVarint(buf, pos);
        if (lnBig > BigInt(n - pos)) {
          break;
        }
        const ln = Number(lnBig);
        val = keep ? buf.subarray(pos, pos + ln) : null;
        pos += ln;
      } else if (wt === 1) {
        if (pos + 8 > n) {
          break;
        }
        val = keep ? buf.subarray(pos, pos + 8) : null;
        pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > n) {
          break;
        }
        val = keep ? buf.subarray(pos, pos + 4) : null;
        pos += 4;
      } else {
        break;
      }
    } catch {
      break;
    }
    if (keep) {
      yield [fn, val];
    }
  }
}

/**
 * Lazily decoded protobuf message mapping field number -> array of raw values.
 */
export class Msg {
  /**
   * @param {Uint8Array | null | undefined} buf
   */
  constructor(buf) {
    /** @type {Map<number, Array<bigint | Uint8Array>>} */
    this.fields = new Map();
    if (!(buf instanceof Uint8Array) || buf.length === 0) {
      return;
    }
    for (const [fn, val] of iterFields(buf)) {
      let arr = this.fields.get(fn);
      if (arr === undefined) {
        arr = [];
        this.fields.set(fn, arr);
      }
      arr.push(val);
    }
  }

  /** @param {number} fn */
  has(fn) {
    return this.fields.has(fn);
  }

  /**
   * @param {number} fn
   * @param {{ signed32?: boolean }} [opts]
   * @returns {number}
   */
  int(fn, { signed32 = false } = {}) {
    const arr = this.fields.get(fn);
    if (!arr || arr.length === 0) {
      return 0;
    }
    let v = arr[arr.length - 1];
    if (typeof v !== 'bigint') {
      return 0;
    }
    if (signed32) {
      v = BigInt.asIntN(64, v);
    }
    return Number(v);
  }

  /**
   * @param {number} fn
   * @returns {Uint8Array}
   */
  bytes(fn) {
    const arr = this.fields.get(fn);
    if (!arr || arr.length === 0) {
      return new Uint8Array(0);
    }
    const v = arr[arr.length - 1];
    return v instanceof Uint8Array ? v : new Uint8Array(0);
  }

  /**
   * @param {number} fn
   * @returns {string}
   */
  str(fn) {
    return UTF8_DECODER.decode(this.bytes(fn));
  }

  /**
   * @param {number} fn
   * @returns {Msg | null}
   */
  msg(fn) {
    return this.has(fn) ? new Msg(this.bytes(fn)) : null;
  }

  /**
   * @param {number} fn
   * @returns {Msg[]}
   */
  msgs(fn) {
    const arr = this.fields.get(fn);
    if (!arr) {
      return [];
    }
    const out = [];
    for (const v of arr) {
      if (v instanceof Uint8Array) {
        out.push(new Msg(v));
      }
    }
    return out;
  }
}
