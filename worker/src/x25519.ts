const P = (1n << 255n) - 19n;
const A24 = 121665n;

function mod(value: bigint): bigint {
  const reduced = value % P;
  return reduced < 0n ? reduced + P : reduced;
}

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[index] ?? 0);
  }
  return value;
}

function encodeLittleEndian(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let remaining = mod(value);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function cswap(swap: bigint, a: bigint, b: bigint): [bigint, bigint] {
  const mask = -swap;
  const dummy = mask & (a ^ b);
  return [a ^ dummy, b ^ dummy];
}

function decodeScalar(bytes: Uint8Array): bigint {
  const clamped = new Uint8Array(bytes);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  return decodeLittleEndian(clamped);
}

function decodeUCoordinate(bytes: Uint8Array): bigint {
  const copy = new Uint8Array(bytes);
  copy[31] &= 127;
  return decodeLittleEndian(copy);
}

export function x25519(scalar: Uint8Array, uCoordinate: Uint8Array): Uint8Array {
  if (scalar.byteLength !== 32 || uCoordinate.byteLength !== 32) {
    throw new Error("X25519 inputs must be 32 bytes");
  }
  const x1 = decodeUCoordinate(uCoordinate);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  const k = decodeScalar(scalar);

  for (let t = 254n; t >= 0n; t -= 1n) {
    const kt = (k >> t) & 1n;
    swap ^= kt;
    [x2, x3] = cswap(swap, x2, x3);
    [z2, z3] = cswap(swap, z2, z3);
    swap = kt;

    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    x3 = mod((da + cb) * (da + cb));
    z3 = mod(x1 * mod((da - cb) * (da - cb)));
    x2 = mod(aa * bb);
    z2 = mod(e * (aa + A24 * e));
  }

  [x2, x3] = cswap(swap, x2, x3);
  [z2, z3] = cswap(swap, z2, z3);
  return encodeLittleEndian(mod(x2 * modPow(z2, P - 2n)));
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

const X25519_BASE = new Uint8Array(32);
X25519_BASE[0] = 9;

export function x25519Base(privateKey: Uint8Array): Uint8Array {
  return x25519(privateKey, X25519_BASE);
}
