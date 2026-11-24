/**
 * The outgoing guard. Before a question leaves the desk it is checked against every private value the desk holds:
 * each address given by flag or typed, and each position's id, quantity and owner suffix. A match stops the
 * question; nothing is sent. The guard fails closed: a short value can stop a question that only resembles it, and
 * a quantity stops every question with a number that holds its digits, whatever value that number has.
 */
import type { DeskState } from "./state";

export interface GuardTerms {
  /** Compared without case, as substrings of the text. */
  substrings: string[];
  /** Decimal quantities in normal form; their significant digits are looked for in every number of the text. */
  quantities: string[];
}

const DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;
const HOLDER = "#holder:";

/** A decimal without leading zeros and without trailing zeros of its fraction. */
function normalNumber(text: string): string {
  const [whole, fraction = ""] = text.split(".");
  const head = whole.replace(/^0+(?=[0-9])/, "");
  const tail = fraction.replace(/0+$/, "");
  return tail === "" ? head : `${head}.${tail}`;
}

/** Every private value the desk holds, as the guard compares it. */
export function guardTerms(state: DeskState): GuardTerms {
  const substrings = new Set<string>();
  const quantities = new Set<string>();
  const add = (value: string): void => {
    if (value !== "") substrings.add(value.toLowerCase());
  };
  for (const address of state.addresses) {
    add(address.address);
    add(`${address.chain}:${address.address}`);
  }
  for (const { position } of state.positions) {
    add(position.id);
    const at = position.subject.indexOf(HOLDER);
    if (at >= 0) add(position.subject.slice(at + HOLDER.length));
    if (DECIMAL.test(position.quantity)) quantities.add(normalNumber(position.quantity));
    else add(position.quantity);
  }
  return { substrings: [...substrings], quantities: [...quantities] };
}

/**
 * The significant digits of a held quantity: its digits without the decimal mark, without leading zeros and
 * without trailing zeros. "1250.5", "1250.50" and "01250.5" give "12505"; "0.5", "500" and "0.05" give "5"; "1250"
 * gives "125", because 1.25e3 writes the same value. Zero gives "0".
 */
function significantDigits(quantity: string): string {
  const digits = quantity.replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return digits === "" ? "0" : digits;
}

/** Characters with no width or shape of their own: controls, format characters, unassigned code points, combining marks. */
const INVISIBLE = /[\p{C}\p{M}]/gu;
/**
 * Characters that can stand inside a written number without ending it: every space, every punctuation character,
 * every symbol, every modifier letter (U+02BC, the letter apostrophe, is one) and the letter e of a power of ten.
 */
const INSIDE_NUMBER = /[\s\p{Z}\p{P}\p{S}\p{Lm}eE]/gu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const DECIMAL_DIGITS = /\p{Nd}/gu;

const digitValues = new Map<string, string>();

/**
 * The value, "0" to "9", of a decimal digit of any script. Unicode encodes the ten digits of a script as one
 * unbroken ascending row, so the value is the distance from the start of the row, modulo ten.
 */
function digitValue(digit: string): string {
  if (digit >= "0" && digit <= "9") return digit;
  let value = digitValues.get(digit);
  if (value === undefined) {
    const point = digit.codePointAt(0) as number;
    let start = point;
    while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
    value = String((point - start) % 10);
    digitValues.set(digit, value);
  }
  return value;
}

/**
 * The text as the guard reads numbers. It is brought to its compatibility form (NFKC: full-width, superscript,
 * subscript and circled digits become plain ones), loses its invisible characters, loses every character that can
 * stand inside a number, and has every decimal digit of any script replaced by 0 to 9. What is left between two
 * digits is a letter, and a letter ends a number.
 */
function numberText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(INSIDE_NUMBER, "").replace(DECIMAL_DIGITS, digitValue);
}

/**
 * Whether a text holds a private value. An address, id or suffix matches as a substring, without case.
 *
 * A quantity matches by its digits, not by its value. A number of the text is a longest stretch of digits and of
 * characters that can stand inside a number. Those characters are: whitespace and separators (`\s`, `\p{Z}`),
 * punctuation (`\p{P}`: point, comma, apostrophes, underscore, hyphens and dashes, the Arabic decimal and thousands
 * marks, brackets, colon, slash), symbols (`\p{S}`: plus, minus, the multiplication signs, asterisk, caret, the
 * fraction slash), modifier letters (`\p{Lm}`: the letter apostrophe U+02BC) and the letters `e` and `E`. Controls,
 * format characters and combining marks (`\p{C}`, `\p{M}`) are dropped first. A decimal digit of any script (`\p{Nd}`) counts as its value. Any other letter ends the number.
 *
 * A question is stopped when the digits of one of its numbers, read in a row, contain the significant digits of a
 * held quantity. For 1250.5, "12505", that stops "1250.50", "1,250.5", "1 250.5", "1250 .5", "1.250,5",
 * "1.2505e3", "1.2505 × 10³", ".12505e4", "١٢٥٠٫٥" and "१२५०.५". It also stops numbers of another value that hold
 * those digits: "12505", "125.05", "3 1250.5 7", and "1250, 5" in a list. A quantity with one significant digit
 * (0.5, 500, 800) stops every question with that digit in it. Nothing is parsed and nothing passes through
 * floating point; the time is linear in the length of the text.
 *
 * Not stopped: a quantity written with a vulgar fraction ("1250½" reads as 1250 1/2), in words ("twelve hundred
 * and fifty point five"), in numerals that are not decimal digits (Roman, or digit-like signs Unicode does not map
 * to a digit), or with a letter between its digits.
 */
export function guardHit(text: string, terms: GuardTerms): boolean {
  const lowered = text.toLowerCase();
  if (terms.substrings.some((term) => lowered.includes(term))) return true;
  if (terms.quantities.length === 0) return false;
  const numbers = numberText(text);
  return terms.quantities.some((quantity) => numbers.includes(significantDigits(quantity)));
}
