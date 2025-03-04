// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { Buffer } from "./buffer.ts";
import { ERR_INVALID_URI } from "./_errors.ts";

/**
 * Alias of querystring.parse()
 * @legacy
 */
export const decode = parse;

/**
 * Alias of querystring.stringify()
 * @legacy
 */
export const encode = stringify;

const hexTable = new Array(256);
for (let i = 0; i < 256; ++i) {
  hexTable[i] = "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase();
}

function encodeStr(
  str: string,
  noEscapeTable: Int8Array,
  hexTable: string[],
): string {
  const len = str.length;
  if (len === 0) return "";

  let out = "";
  let lastPos = 0;

  for (let i = 0; i < len; i++) {
    let c = str.charCodeAt(i);
    // ASCII
    if (c < 0x80) {
      if (noEscapeTable[c] === 1) continue;
      if (lastPos < i) out += str.slice(lastPos, i);
      lastPos = i + 1;
      out += hexTable[c];
      continue;
    }

    if (lastPos < i) out += str.slice(lastPos, i);

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xc0 | (c >> 6)] + hexTable[0x80 | (c & 0x3f)];
      continue;
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1;
      out += hexTable[0xe0 | (c >> 12)] + hexTable[0x80 | ((c >> 6) & 0x3f)] +
        hexTable[0x80 | (c & 0x3f)];
      continue;
    }
    // Surrogate pair
    ++i;

    // This branch should never happen because all URLSearchParams entries
    // should already be converted to USVString. But, included for
    // completion's sake anyway.
    if (i >= len) throw new ERR_INVALID_URI();

    const c2 = str.charCodeAt(i) & 0x3ff;

    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3ff) << 10) | c2);
    out += hexTable[0xf0 | (c >> 18)] +
      hexTable[0x80 | ((c >> 12) & 0x3f)] +
      hexTable[0x80 | ((c >> 6) & 0x3f)] +
      hexTable[0x80 | (c & 0x3f)];
  }
  if (lastPos === 0) return str;
  if (lastPos < len) return out + str.slice(lastPos);
  return out;
}

/**
 * replaces encodeURIComponent()
 * @see https://www.ecma-international.org/ecma-262/5.1/#sec-15.1.3.4
 */
function qsEscape(str: unknown): string {
  if (typeof str !== "string") {
    if (typeof str === "object") {
      str = String(str);
    } else {
      str += "";
    }
  }
  return encodeStr(str as string, noEscape, hexTable);
}

/**
 * Performs URL percent-encoding on the given `str` in a manner that is optimized for the specific requirements of URL query strings.
 * Used by `querystring.stringify()` and is generally not expected to be used directly.
 * It is exported primarily to allow application code to provide a replacement percent-encoding implementation if necessary by assigning `querystring.escape` to an alternative function.
 * @legacy
 * @see Tested in `test-querystring-escape.js`
 */
export const escape = qsEscape;

interface ParsedUrlQuery {
  [key: string]: string | string[] | undefined;
}

interface ParseOptions {
  /** The function to use when decoding percent-encoded characters in the query string. */
  decodeURIComponent?: (string: string) => string;
  /** Specifies the maximum number of keys to parse. */
  maxKeys?: number;
}

// deno-fmt-ignore
const isHexTable = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 64 - 79
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 96 - 111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 112 - 127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128 ...
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // ... 256
]);

function charCodes(str: string): number[] {
  const ret = new Array(str.length);
  for (let i = 0; i < str.length; ++i) {
    ret[i] = str.charCodeAt(i);
  }
  return ret;
}

function addKeyVal(
  obj: ParsedUrlQuery,
  key: string,
  value: string,
  keyEncoded: boolean,
  valEncoded: boolean,
  decode: (encodedURIComponent: string) => string,
): void {
  if (key.length > 0 && keyEncoded) {
    key = decode(key);
  }
  if (value.length > 0 && valEncoded) {
    value = decode(value);
  }

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // A simple Array-specific property check is enough here to
    // distinguish from a string value and is faster and still safe
    // since we are generating all of the values being assigned.
    if ((curValue as string[]).pop) {
      (curValue as string[])[curValue!.length] = value;
    } else {
      obj[key] = [curValue as string, value];
    }
  }
}

/**
 * Parses a URL query string into a collection of key and value pairs.
 * @param str The URL query string to parse
 * @param sep The substring used to delimit key and value pairs in the query string. Default: '&'.
 * @param eq The substring used to delimit keys and values in the query string. Default: '='.
 * @param options The parse options
 * @param options.decodeURIComponent The function to use when decoding percent-encoded characters in the query string. Default: `querystring.unescape()`.
 * @param options.maxKeys Specifies the maximum number of keys to parse. Specify `0` to remove key counting limitations. Default: `1000`.
 * @legacy
 * @see Tested in test-querystring.js
 */
export function parse(
  str: string,
  sep = "&",
  eq = "=",
  { decodeURIComponent = unescape, maxKeys = 1000 }: ParseOptions = {},
): ParsedUrlQuery {
  const obj: ParsedUrlQuery = Object.create(null);

  if (typeof str !== "string" || str.length === 0) {
    return obj;
  }

  const sepCodes = (!sep ? [38] /* & */ : charCodes(String(sep)));
  const eqCodes = (!eq ? [61] /* = */ : charCodes(String(eq)));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (typeof maxKeys === "number") {
    // -1 is used in place of a value like Infinity for meaning
    // "unlimited pairs" because of additional checks V8 (at least as of v5.4)
    // has to do when using variables that contain values like Infinity. Since
    // `pairs` is always decremented and checked explicitly for 0, -1 works
    // effectively the same as Infinity, while providing a significant
    // performance boost.
    pairs = maxKeys > 0 ? maxKeys : -1;
  }

  let decode = unescape;
  if (decodeURIComponent) {
    decode = decodeURIComponent;
  }
  const customDecode = (decode !== unescape);

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = "";
  let value = "";
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = (customDecode ? "%20" : " ");
  let encodeCheck = 0;
  for (let i = 0; i < str.length; ++i) {
    const code = str.charCodeAt(i);

    // Try matching key/value pair separator (e.g. '&')
    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        // Key/value pair separator match!
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // We didn't find the (entire) key/value separator
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value
            key += str.slice(lastPos, end);
          } else if (key.length === 0) {
            // We saw an empty substring between separators
            if (--pairs === 0) {
              return obj;
            }
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += str.slice(lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0) {
          return obj;
        }
        key = value = "";
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      // Try matching key/value separator (e.g. '=') if we haven't already
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            // Key/value separator match!
            const end = i - eqIdx + 1;
            if (lastPos < end) {
              key += str.slice(lastPos, end);
            }
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // Try to match an (valid) encoded byte once to minimize unnecessary
            // calls to string decoding functions
            if (code === 37 /* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (isHexTable[code] === 1) {
                if (++encodeCheck === 3) {
                  keyEncoded = true;
                }
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43 /* + */) {
          if (lastPos < i) {
            key += str.slice(lastPos, i);
          }
          key += plusChar;
          lastPos = i + 1;
          continue;
        }
      }
      if (code === 43 /* + */) {
        if (lastPos < i) {
          value += str.slice(lastPos, i);
        }
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        // Try to match an (valid) encoded byte (once) to minimize unnecessary
        // calls to string decoding functions
        if (code === 37 /* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (isHexTable[code] === 1) {
            if (++encodeCheck === 3) {
              valEncoded = true;
            }
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  // Deal with any leftover key or value data
  if (lastPos < str.length) {
    if (eqIdx < eqLen) {
      key += str.slice(lastPos);
    } else if (sepIdx < sepLen) {
      value += str.slice(lastPos);
    }
  } else if (eqIdx === 0 && key.length === 0) {
    // We ended on an empty substring
    return obj;
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}

interface StringifyOptions {
  /** The function to use when converting URL-unsafe characters to percent-encoding in the query string. */
  encodeURIComponent: (string: string) => string;
}

/**
 * These characters do not need escaping when generating query strings:
 * ! - . _ ~
 * ' ( ) *
 * digits
 * alpha (uppercase)
 * alpha (lowercase)
 */
// deno-fmt-ignore
const noEscape = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,  // 112 - 127
]);

// deno-lint-ignore no-explicit-any
function stringifyPrimitive(v: any): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && isFinite(v)) {
    return "" + v;
  }
  if (typeof v === "bigint") {
    return "" + v;
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return "";
}

function encodeStringifiedCustom(
  // deno-lint-ignore no-explicit-any
  v: any,
  encode: (string: string) => string,
): string {
  return encode(stringifyPrimitive(v));
}

// deno-lint-ignore no-explicit-any
function encodeStringified(v: any, encode: (string: string) => string): string {
  if (typeof v === "string") {
    return (v.length ? encode(v) : "");
  }
  if (typeof v === "number" && isFinite(v)) {
    // Values >= 1e21 automatically switch to scientific notation which requires
    // escaping due to the inclusion of a '+' in the output
    return (Math.abs(v) < 1e21 ? "" + v : encode("" + v));
  }
  if (typeof v === "bigint") {
    return "" + v;
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return "";
}

/**
 * Produces a URL query string from a given obj by iterating through the object's "own properties".
 * @param obj The object to serialize into a URL query string.
 * @param sep The substring used to delimit key and value pairs in the query string. Default: '&'.
 * @param eq The substring used to delimit keys and values in the query string. Default: '='.
 * @param options The stringify options
 * @param options.encodeURIComponent The function to use when converting URL-unsafe characters to percent-encoding in the query string. Default: `querystring.escape()`.
 * @legacy
 * @see Tested in `test-querystring.js`
 */
export function stringify(
  // deno-lint-ignore no-explicit-any
  obj: Record<string, any>,
  sep?: string,
  eq?: string,
  options?: StringifyOptions,
): string {
  sep ||= "&";
  eq ||= "=";
  const encode = options ? options.encodeURIComponent : qsEscape;
  const convert = options ? encodeStringifiedCustom : encodeStringified;

  if (obj !== null && typeof obj === "object") {
    const keys = Object.keys(obj);
    const len = keys.length;
    let fields = "";
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = obj[k];
      let ks = convert(k, encode);
      ks += eq;

      if (Array.isArray(v)) {
        const vlen = v.length;
        if (vlen === 0) continue;
        if (fields) {
          fields += sep;
        }
        for (let j = 0; j < vlen; ++j) {
          if (j) {
            fields += sep;
          }
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields) {
          fields += sep;
        }
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return "";
}

// deno-fmt-ignore
const unhexTable = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 0 - 15
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 16 - 31
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 32 - 47
  +0, +1, +2, +3, +4, +5, +6, +7, +8, +9, -1, -1, -1, -1, -1, -1, // 48 - 63
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 64 - 79
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 80 - 95
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 96 - 111
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 112 - 127
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 128 ...
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // ... 255
]);

/**
 * A safe fast alternative to decodeURIComponent
 */
export function unescapeBuffer(s: string, decodeSpaces = false): Buffer {
  const out = new Buffer(s.length);
  let index = 0;
  let outIndex = 0;
  let currentChar;
  let nextChar;
  let hexHigh;
  let hexLow;
  const maxLength = s.length - 2;
  // Flag to know if some hex chars have been decoded
  let hasHex = false;
  while (index < s.length) {
    currentChar = s.charCodeAt(index);
    if (currentChar === 43 /* '+' */ && decodeSpaces) {
      out[outIndex++] = 32; // ' '
      index++;
      continue;
    }
    if (currentChar === 37 /* '%' */ && index < maxLength) {
      currentChar = s.charCodeAt(++index);
      hexHigh = unhexTable[currentChar];
      if (!(hexHigh >= 0)) {
        out[outIndex++] = 37; // '%'
        continue;
      } else {
        nextChar = s.charCodeAt(++index);
        hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37; // '%'
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out[outIndex++] = currentChar;
    index++;
  }
  return hasHex ? out.slice(0, outIndex) : out;
}

function qsUnescape(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return unescapeBuffer(s).toString();
  }
}

/**
 * Performs decoding of URL percent-encoded characters on the given `str`.
 * Used by `querystring.parse()` and is generally not expected to be used directly.
 * It is exported primarily to allow application code to provide a replacement decoding implementation if necessary by assigning `querystring.unescape` to an alternative function.
 * @legacy
 * @see Tested in `test-querystring-escape.js`
 */
export const unescape = qsUnescape;

export default {
  parse,
  stringify,
  decode,
  encode,
  unescape,
  escape,
  unescapeBuffer,
};
