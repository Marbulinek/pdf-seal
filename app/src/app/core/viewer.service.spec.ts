import { isDarkPixels } from './viewer.service';

const pixels = (r: number, g: number, b: number, n = 4) => new Uint8ClampedArray(Array.from({ length: n }, () => [r, g, b, 255]).flat());

describe('isDarkPixels', () => {
  it('reads black and dark blue as dark, white and yellow as light', () => {
    expect(isDarkPixels(pixels(0, 0, 0))).toBe(true);
    expect(isDarkPixels(pixels(20, 40, 120))).toBe(true);
    expect(isDarkPixels(pixels(255, 255, 255))).toBe(false);
    expect(isDarkPixels(pixels(250, 220, 60))).toBe(false);
    expect(isDarkPixels(new Uint8ClampedArray())).toBe(false);
  });
});
