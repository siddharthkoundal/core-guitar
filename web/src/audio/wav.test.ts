import { expect, it } from 'vitest';
import { encodeWav } from './wav';

it('encodes mono PCM16 with correct size, native rate and clipped samples', async () => {
  const bytes = encodeWav([new Float32Array([-2, -1, 0, 1, 2])], 48000);
  const data = new DataView(bytes);
  expect(data.getUint32(24, true)).toBe(48000);
  expect(data.getUint16(22, true)).toBe(1);
  expect(data.getUint16(34, true)).toBe(16);
  expect(data.getUint32(40, true)).toBe(10);
  expect(data.getInt16(44, true)).toBe(-32768);
  expect(data.getInt16(52, true)).toBe(32767);
});

it('concatenates capture buffers without gaps and rejects invalid rates', () => {
  const data = new DataView(encodeWav([new Float32Array([0]), new Float32Array([0.5])], 44100));
  expect(data.byteLength).toBe(48);
  expect(data.getInt16(46, true)).toBe(16383);
  expect(() => encodeWav([], 0)).toThrow();
});
