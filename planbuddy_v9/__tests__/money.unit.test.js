'use strict';

const { rupeesToPaise, paiseToRupees, assertPaise, toCanonicalPaise } = require('../utils/money');

describe('Money utility functions', () => {
  test.each([
    [1, 100],
    [10, 1000],
    [99.99, 9999],
    [100, 10000],
    [999.99, 99999],
    [1000, 100000],
  ])('rupeesToPaise(%p) === %p', (rupees, expected) => {
    expect(rupeesToPaise(rupees)).toBe(expected);
  });

  test.each([
    [100, 1.00],
    [1000, 10.00],
    [9999, 99.99],
    [10000, 100.00],
    [99999, 999.99],
    [100000, 1000.00],
  ])('paiseToRupees(%p) === %p', (paise, expected) => {
    expect(paiseToRupees(paise)).toBe(expected);
  });

  test('assertPaise accepts integer paise values', () => {
    expect(() => assertPaise(100)).not.toThrow();
    expect(() => assertPaise(0)).not.toThrow();
  });

  test('assertPaise rejects fractional amounts and rupees-shaped values', () => {
    expect(() => assertPaise(99.99)).toThrow();
    expect(() => assertPaise(100.5)).toThrow();
  });

  test('toCanonicalPaise converts rupees explicitly', () => {
    expect(toCanonicalPaise(99.99, 'rupees')).toBe(9999);
  });

  test('toCanonicalPaise preserves true paise values', () => {
    expect(toCanonicalPaise(1000, 'paise')).toBe(1000);
  });
});
