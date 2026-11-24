/**
 * What may not leave through the answers route: the address, the position ids and the quantities of any read this
 * process has returned. A request body that holds one is refused before the answers handler sees it.
 */
import type { ReadData } from "./model";

// A decimal value is coefficient × 10^exponent. Keep both as text/BigInt rather than
// rounding through Number or allocating a string as large as an exponent requests.
function decimalValue(text: string): string | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? "";
  const digits = ((match[2] ?? "") + fraction).replace(/^0+/, "");
  if (digits === "") return "0";
  let end = digits.length;
  while (digits[end - 1] === "0") end--;
  const coefficient = digits.slice(0, end);
  const exponent = BigInt(match[5] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${match[1] === "-" ? "-" : ""}${coefficient}e${exponent}`;
}

const DECIMALS = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
// The server validates JSON first. Quoted strings are consumed whole and decoded
// separately; number tokens retain their exact original digits, including exponents.
const JSON_ATOMS = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export class PrivateTerms {
  private readonly exact = new Set<string>();
  private readonly quantities = new Set<string>();
  private readonly otherQuantities = new Set<string>();

  /** Remembers the private values of one read. */
  add(read: ReadData): void {
    if (read.address !== "") this.exact.add(read.address);
    for (const row of read.list.rows) {
      if (row.key !== "") this.exact.add(row.key);
      const quantity = row.values.quantity;
      if ((typeof quantity === "string" && quantity !== "") || typeof quantity === "number") {
        const text = String(quantity);
        const value = decimalValue(text);
        if (value === null) this.otherQuantities.add(text);
        else this.quantities.add(value);
      }
    }
  }

  /** Whether text names a private identity or an exactly equivalent decimal quantity. */
  hit(text: string): boolean {
    for (const term of this.exact) if (text.includes(term)) return true;
    for (const quantity of this.otherQuantities) if (text.includes(quantity)) return true;
    for (const match of text.matchAll(DECIMALS)) {
      const value = decimalValue(match[0]);
      if (value !== null && this.quantities.has(value)) return true;
    }
    return false;
  }

  /** Checks an already-validated JSON document without rounding its numeric tokens. */
  hitJson(text: string): boolean {
    for (const match of text.matchAll(JSON_ATOMS)) {
      const atom = match[0];
      if (this.hit(atom.startsWith('"') ? JSON.parse(atom) as string : atom)) return true;
    }
    return false;
  }
}
