"""Minimal zero-dependency protobuf wire decoder."""

from __future__ import annotations


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode an unsigned base-128 varint starting at pos."""
    val = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
    raise ValueError("Truncated varint")


def encode_varint(n: int) -> bytes:
    """Encode a non-negative integer as a base-128 varint."""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class Msg:
    """Lazily decoded protobuf message mapping field number -> list of raw values."""

    __slots__ = ("fields",)

    def __init__(self, buf: bytes | None):
        self.fields: dict[int, list] = {}
        if not buf:
            return
        pos, n = 0, len(buf)
        while pos < n:
            try:
                tag, pos = read_varint(buf, pos)
                fn, wt = tag >> 3, tag & 7
                if fn == 0:
                    break
                if wt == 0:
                    val, pos = read_varint(buf, pos)
                elif wt == 2:
                    ln, pos = read_varint(buf, pos)
                    if pos + ln > n:
                        break
                    val = buf[pos : pos + ln]
                    pos += ln
                elif wt == 1:
                    if pos + 8 > n:
                        break
                    val, pos = buf[pos : pos + 8], pos + 8
                elif wt == 5:
                    if pos + 4 > n:
                        break
                    val, pos = buf[pos : pos + 4], pos + 4
                else:
                    break
            except ValueError:
                break
            self.fields.setdefault(fn, []).append(val)

    def has(self, fn: int) -> bool:
        return fn in self.fields

    def int(self, fn: int, signed32: bool = False) -> int:
        v = self.fields.get(fn, [0])[-1]
        v = v if isinstance(v, int) else 0
        if signed32 and v >= (1 << 63):
            v -= 1 << 64
        return v

    def bytes(self, fn: int) -> bytes:
        v = self.fields.get(fn, [b""])[-1]
        return v if isinstance(v, bytes) else b""

    def str(self, fn: int) -> str:
        return self.bytes(fn).decode("utf-8", errors="replace")

    def msg(self, fn: int) -> "Msg | None":
        return Msg(self.bytes(fn)) if self.has(fn) else None

    def msgs(self, fn: int) -> list["Msg"]:
        return [Msg(v) for v in self.fields.get(fn, []) if isinstance(v, bytes)]
