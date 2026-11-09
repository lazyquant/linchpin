function quote(value: string): string {
  const escapes: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  return '"' + value.replace(/["\\\x00-\x1f\x7f-\uffff]/g, (char) =>
    escapes[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) + '"';
}

function numberRepr(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // JS cannot distinguish 1.0 from 1: integral floats omit .0. At 1e16 the lab uses scientific notation.
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  const [mantissa, power] = value.toExponential().split("e");
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 16) {
    return `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const sign = value < 0 ? "-" : "";
  const digits = mantissa.replace(/[-.]/g, "");
  const point = exponent + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Python's json.dumps: the exact bytes every fingerprint reads. */
export function pyDumps(value: unknown, options: { sortKeys?: boolean } = {}): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") return numberRepr(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item: unknown) => pyDumps(item, options)).join(", ")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((key) => obj[key] !== undefined);
    if (options.sortKeys) keys.sort();
    return `{${keys.map((key) => `${quote(key)}: ${pyDumps(obj[key], options)}`).join(", ")}}`;
  }
  throw new Error("Expected a JSON-like value.");
}
