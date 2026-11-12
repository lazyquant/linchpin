/** Non-negative decimal arithmetic. No conversion of quantities to floating point. */
export interface Decimal { coefficient: bigint; scale: number }
export const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
export function parseDecimal(value: string): Decimal {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) throw new Error("malformed-decimal");
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function decimal(value: string | Decimal): Decimal { return typeof value === "string" ? parseDecimal(value) : value; }
export function normalizeDecimal(value: string | Decimal): string {
  const { coefficient, scale } = decimal(value);
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}
function align(a: string | Decimal, b: string | Decimal): [bigint, bigint, number] {
  const x = decimal(a), y = decimal(b), scale = Math.max(x.scale, y.scale);
  return [x.coefficient * 10n ** BigInt(scale - x.scale), y.coefficient * 10n ** BigInt(scale - y.scale), scale];
}
export function addDecimals(a: string | Decimal, b: string | Decimal): string {
  const [x, y, scale] = align(a, b); return normalizeDecimal({ coefficient: x + y, scale });
}
export function multiplyDecimals(a: string | Decimal, b: string | Decimal): string {
  const x = decimal(a), y = decimal(b); return normalizeDecimal({ coefficient: x.coefficient * y.coefficient, scale: x.scale + y.scale });
}
export function compareDecimals(a: string | Decimal, b: string | Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0;
}
