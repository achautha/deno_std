// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

import { validateString } from "../../_validators.ts";
import * as types from "../../_util/_util_types.ts";
import {
  ALL_PROPERTIES,
  getOwnNonIndexProperties,
  ONLY_ENUMERABLE,
} from "../../internal_binding/util.ts";

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

const kMinLineLength = 16;

// Constants to map the iterator state.
const kWeak = 0;
const kIterator = 1;
const kMapEntries = 2;

const kPending = 0;
const kRejected = 2;

// Escaped control characters (plus the single quote and the backslash). Use
// empty strings to fill up unused entries.
// deno-fmt-ignore
const meta = [
  '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', // x07
  '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',           // x0F
  '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', // x17
  '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F', // x1F
  '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',      // x2F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x3F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x4F
  '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',     // x5F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x6F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',    // x7F
  '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87', // x87
  '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F', // x8F
  '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97', // x97
  '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F', // x9F
];

// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
const isUndetectableObject = (v) => typeof v === "undefined" && v !== undefined;

// deno-lint-ignore no-control-regex
const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]/;
// deno-lint-ignore no-control-regex
const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]/g;
// deno-lint-ignore no-control-regex
const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]/;
// deno-lint-ignore no-control-regex
const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]/g;

const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;
const nodeModulesRegExp = /[/\\]node_modules[/\\](.+?)(?=[/\\])/g;

const classRegExp = /^(\s+[^(]*?)\s*{/;
// eslint-disable-next-line node-core/no-unescaped-regexp-dot
const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

const inspectDefaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
};

function getUserOptions(ctx, isCrossContext) {
  const ret = {
    stylize: ctx.stylize,
    showHidden: ctx.showHidden,
    depth: ctx.depth,
    colors: ctx.colors,
    customInspect: ctx.customInspect,
    showProxy: ctx.showProxy,
    maxArrayLength: ctx.maxArrayLength,
    maxStringLength: ctx.maxStringLength,
    breakLength: ctx.breakLength,
    compact: ctx.compact,
    sorted: ctx.sorted,
    getters: ctx.getters,
    ...ctx.userOptions,
  };

  // Typically, the target value will be an instance of `Object`. If that is
  // *not* the case, the object may come from another vm.Context, and we want
  // to avoid passing it objects from this Context in that case, so we remove
  // the prototype from the returned object itself + the `stylize()` function,
  // and remove all other non-primitives, including non-primitive user options.
  if (isCrossContext) {
    Object.setPrototypeOf(ret, null);
    for (const key of Object.keys(ret)) {
      if (
        (typeof ret[key] === "object" || typeof ret[key] === "function") &&
        ret[key] !== null
      ) {
        delete ret[key];
      }
    }
    ret.stylize = Object.setPrototypeOf((value, flavour) => {
      let stylized;
      try {
        stylized = `${ctx.stylize(value, flavour)}`;
      } catch {
        // noop
      }

      if (typeof stylized !== "string") return value;
      // `stylized` is a string as it should be, which is safe to pass along.
      return stylized;
    }, null);
  }

  return ret;
}

/**
 * Echos the value of any input. Tries to print the value out
 * in the best way possible given the different types.
 */
/* Legacy: value, showHidden, depth, colors */
export function inspect(value, opts) {
  // Default options
  const ctx = {
    budget: {},
    indentationLvl: 0,
    seen: [],
    currentDepth: 0,
    stylize: stylizeNoColor,
    showHidden: inspectDefaultOptions.showHidden,
    depth: inspectDefaultOptions.depth,
    colors: inspectDefaultOptions.colors,
    customInspect: inspectDefaultOptions.customInspect,
    showProxy: inspectDefaultOptions.showProxy,
    maxArrayLength: inspectDefaultOptions.maxArrayLength,
    maxStringLength: inspectDefaultOptions.maxStringLength,
    breakLength: inspectDefaultOptions.breakLength,
    compact: inspectDefaultOptions.compact,
    sorted: inspectDefaultOptions.sorted,
    getters: inspectDefaultOptions.getters,
  };
  if (arguments.length > 1) {
    // Legacy...
    if (arguments.length > 2) {
      if (arguments[2] !== undefined) {
        ctx.depth = arguments[2];
      }
      if (arguments.length > 3 && arguments[3] !== undefined) {
        ctx.colors = arguments[3];
      }
    }
    // Set user-specified options
    if (typeof opts === "boolean") {
      ctx.showHidden = opts;
    } else if (opts) {
      const optKeys = Object.keys(opts);
      for (let i = 0; i < optKeys.length; ++i) {
        const key = optKeys[i];
        // TODO(BridgeAR): Find a solution what to do about stylize. Either make
        // this function public or add a new API with a similar or better
        // functionality.
        if (
          // deno-lint-ignore no-prototype-builtins
          inspectDefaultOptions.hasOwnProperty(key) ||
          key === "stylize"
        ) {
          ctx[key] = opts[key];
        } else if (ctx.userOptions === undefined) {
          // This is required to pass through the actual user input.
          ctx.userOptions = opts;
        }
      }
    }
  }
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
  if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
  return formatValue(ctx, value, 0);
}
const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
inspect.custom = customInspectSymbol;

Object.defineProperty(inspect, "defaultOptions", {
  get() {
    return inspectDefaultOptions;
  },
  set(options) {
    // TODO(wafuwafu13): Validate
    // validateObject(options, 'options');
    return Object.assign(inspectDefaultOptions, options);
  },
});

// Set Graphics Rendition https://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Each color consists of an array with the color code as first entry and the
// reset code as second entry.
const defaultFG = 39;
const defaultBG = 49;
inspect.colors = Object.assign(Object.create(null), {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22], // Alias: faint
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  // Swap foreground and background colors
  inverse: [7, 27], // Alias: swapcolors, swapColors
  hidden: [8, 28], // Alias: conceal
  strikethrough: [9, 29], // Alias: strikeThrough, crossedout, crossedOut
  doubleunderline: [21, 24], // Alias: doubleUnderline
  black: [30, defaultFG],
  red: [31, defaultFG],
  green: [32, defaultFG],
  yellow: [33, defaultFG],
  blue: [34, defaultFG],
  magenta: [35, defaultFG],
  cyan: [36, defaultFG],
  white: [37, defaultFG],
  bgBlack: [40, defaultBG],
  bgRed: [41, defaultBG],
  bgGreen: [42, defaultBG],
  bgYellow: [43, defaultBG],
  bgBlue: [44, defaultBG],
  bgMagenta: [45, defaultBG],
  bgCyan: [46, defaultBG],
  bgWhite: [47, defaultBG],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, defaultFG], // Alias: grey, blackBright
  redBright: [91, defaultFG],
  greenBright: [92, defaultFG],
  yellowBright: [93, defaultFG],
  blueBright: [94, defaultFG],
  magentaBright: [95, defaultFG],
  cyanBright: [96, defaultFG],
  whiteBright: [97, defaultFG],
  bgGray: [100, defaultBG], // Alias: bgGrey, bgBlackBright
  bgRedBright: [101, defaultBG],
  bgGreenBright: [102, defaultBG],
  bgYellowBright: [103, defaultBG],
  bgBlueBright: [104, defaultBG],
  bgMagentaBright: [105, defaultBG],
  bgCyanBright: [106, defaultBG],
  bgWhiteBright: [107, defaultBG],
});

function defineColorAlias(target, alias) {
  Object.defineProperty(inspect.colors, alias, {
    get() {
      return this[target];
    },
    set(value) {
      this[target] = value;
    },
    configurable: true,
    enumerable: false,
  });
}

defineColorAlias("gray", "grey");
defineColorAlias("gray", "blackBright");
defineColorAlias("bgGray", "bgGrey");
defineColorAlias("bgGray", "bgBlackBright");
defineColorAlias("dim", "faint");
defineColorAlias("strikethrough", "crossedout");
defineColorAlias("strikethrough", "strikeThrough");
defineColorAlias("strikethrough", "crossedOut");
defineColorAlias("hidden", "conceal");
defineColorAlias("inverse", "swapColors");
defineColorAlias("inverse", "swapcolors");
defineColorAlias("doubleunderline", "doubleUnderline");

// TODO(BridgeAR): Add function style support for more complex styles.
// Don't use 'blue' not visible on cmd.exe
inspect.styles = Object.assign(Object.create(null), {
  special: "cyan",
  number: "yellow",
  bigint: "yellow",
  boolean: "yellow",
  undefined: "grey",
  null: "bold",
  string: "green",
  symbol: "green",
  date: "magenta",
  // "name": intentionally not styling
  // TODO(BridgeAR): Highlight regular expressions properly.
  regexp: "red",
  module: "underline",
});

function addQuotes(str, quotes) {
  if (quotes === -1) {
    return `"${str}"`;
  }
  if (quotes === -2) {
    return `\`${str}\``;
  }
  return `'${str}'`;
}

// TODO(wafuwafu13): Figure out
const escapeFn = (str) => meta[str.charCodeAt(0)];

// Escape control characters, single quotes and the backslash.
// This is similar to JSON stringify escaping.
function strEscape(str) {
  let escapeTest = strEscapeSequencesRegExp;
  let escapeReplace = strEscapeSequencesReplacer;
  let singleQuote = 39;

  // Check for double quotes. If not present, do not escape single quotes and
  // instead wrap the text in double quotes. If double quotes exist, check for
  // backticks. If they do not exist, use those as fallback instead of the
  // double quotes.
  if (str.includes("'")) {
    // This invalidates the charCode and therefore can not be matched for
    // anymore.
    if (!str.includes('"')) {
      singleQuote = -1;
    } else if (
      !str.includes("`") &&
      !str.includes("${")
    ) {
      singleQuote = -2;
    }
    if (singleQuote !== 39) {
      escapeTest = strEscapeSequencesRegExpSingle;
      escapeReplace = strEscapeSequencesReplacerSingle;
    }
  }

  // Some magic numbers that worked out fine while benchmarking with v8 6.0
  if (str.length < 5000 && !escapeTest.test(str)) {
    return addQuotes(str, singleQuote);
  }
  if (str.length > 100) {
    str = str.replace(escapeReplace, escapeFn);
    return addQuotes(str, singleQuote);
  }

  let result = "";
  let last = 0;
  const lastIndex = str.length;
  for (let i = 0; i < lastIndex; i++) {
    const point = str.charCodeAt(i);
    if (
      point === singleQuote ||
      point === 92 ||
      point < 32 ||
      (point > 126 && point < 160)
    ) {
      if (last === i) {
        result += meta[point];
      } else {
        result += `${str.slice(last, i)}${meta[point]}`;
      }
      last = i + 1;
    }
  }

  if (last !== lastIndex) {
    result += str.slice(last);
  }
  return addQuotes(result, singleQuote);
}

function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (style !== undefined) {
    const color = inspect.colors[style];
    if (color !== undefined) {
      return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
    }
  }
  return str;
}

function stylizeNoColor(str) {
  return str;
}

// Note: using `formatValue` directly requires the indentation level to be
// corrected by setting `ctx.indentationLvL += diff` and then to decrease the
// value afterwards again.
function formatValue(
  ctx,
  value,
  recurseTimes,
  typedArray,
) {
  // Primitive types cannot have properties.
  if (
    typeof value !== "object" &&
    typeof value !== "function" &&
    !isUndetectableObject(value)
  ) {
    return formatPrimitive(ctx.stylize, value, ctx);
  }
  if (value === null) {
    return ctx.stylize("null", "null");
  }

  // Memorize the context for custom inspection on proxies.
  const context = value;
  // Always check for proxies to prevent side effects and to prevent triggering
  // any proxy handlers.
  // TODO(wafuwafu13): Set Proxy
  const proxy = undefined;
  // const proxy = getProxyDetails(value, !!ctx.showProxy);
  // if (proxy !== undefined) {
  //   if (ctx.showProxy) {
  //     return formatProxy(ctx, proxy, recurseTimes);
  //   }
  //   value = proxy;
  // }

  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it.
  if (ctx.customInspect) {
    const maybeCustom = value[customInspectSymbol];
    if (
      typeof maybeCustom === "function" &&
      // Filter out the util module, its inspect function is special.
      maybeCustom !== inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)
    ) {
      // This makes sure the recurseTimes are reported as before while using
      // a counter internally.
      const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
      const isCrossContext = proxy !== undefined ||
        !(context instanceof Object);
      const ret = maybeCustom.call(
        context,
        depth,
        getUserOptions(ctx, isCrossContext),
      );
      // If the custom inspection method returned `this`, don't go into
      // infinite recursion.
      if (ret !== context) {
        if (typeof ret !== "string") {
          return formatValue(ctx, ret, recurseTimes);
        }
        return ret.replace(/\n/g, `\n${" ".repeat(ctx.indentationLvl)}`);
      }
    }
  }

  // Using an array here is actually better for the average case than using
  // a Set. `seen` will only check for the depth and will never grow too large.
  if (ctx.seen.includes(value)) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new Map();
      ctx.circular.set(value, index);
    } else {
      index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
    }
    return ctx.stylize(`[Circular *${index}]`, "special");
  }

  return formatRaw(ctx, value, recurseTimes, typedArray);
}

function formatRaw(ctx, value, recurseTimes, typedArray) {
  let keys;
  let protoProps;
  if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
    protoProps = [];
  }

  const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
  // Reset the variable to check for this later on.
  if (protoProps !== undefined && protoProps.length === 0) {
    protoProps = undefined;
  }

  let tag = value[Symbol.toStringTag];
  // Only list the tag in case it's non-enumerable / not an own property.
  // Otherwise we'd print this twice.
  if (
    typeof tag !== "string"
    // TODO(wafuwafu13): Implement
    // (tag !== "" &&
    //   (ctx.showHidden
    //     ? Object.prototype.hasOwnProperty
    //     : Object.prototype.propertyIsEnumerable)(
    //       value,
    //       Symbol.toStringTag,
    //     ))
  ) {
    tag = "";
  }
  let base = "";
  let formatter = getEmptyFormatArray;
  let braces;
  let noIterator = true;
  let i = 0;
  const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;

  let extrasType = kObjectType;

  // Iterators and the rest are split to reduce checks.
  // We have to check all values in case the constructor is set to null.
  // Otherwise it would not possible to identify all types properly.
  if (value[Symbol.iterator] || constructor === null) {
    noIterator = false;
    if (Array.isArray(value)) {
      // Only set the constructor for non ordinary ("Array [...]") arrays.
      const prefix = (constructor !== "Array" || tag !== "")
        ? getPrefix(constructor, tag, "Array", `(${value.length})`)
        : "";
      keys = getOwnNonIndexProperties(value, filter);
      braces = [`${prefix}[`, "]"];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined) {
        return `${braces[0]}]`;
      }
      extrasType = kArrayExtrasType;
      formatter = formatArray;
    } else if (types.isSet(value)) {
      const size = value.size;
      const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      (formatter) = constructor !== null
        ? formatSet.bind(null, value)
        : formatSet.bind(null, value.values());
      if (size === 0 && keys.length === 0 && protoProps === undefined) {
        return `${prefix}{}`;
      }
      braces = [`${prefix}{`, "}"];
    } else if (types.isMap(value)) {
      const size = value.size;
      const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      (formatter) = constructor !== null
        ? formatMap.bind(null, value)
        : formatMap.bind(null, value.entries());
      if (size === 0 && keys.length === 0 && protoProps === undefined) {
        return `${prefix}{}`;
      }
      braces = [`${prefix}{`, "}"];
    } else if (types.isTypedArray(value)) {
      // TODO(wafuwafu13): Imprement
      keys = [value];
      // keys = getOwnNonIndexProperties(value, filter);
      const bound = value;
      const fallback = "";
      if (constructor === null) {
        // TODO(wafuwafu13): Implement
        // fallback = TypedArrayPrototypeGetSymbolToStringTag(value);
        // // Reconstruct the array information.
        // bound = new primordials[fallback](value);
      }
      const size = value.length;
      const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
      braces = [`${prefix}[`, "]"];
      if (value.length === 0 && keys.length === 0 && !ctx.showHidden) {
        return `${braces[0]}]`;
      }
      // Special handle the value. The original value is required below. The
      // bound function is required to reconstruct missing information.
      (formatter) = formatTypedArray.bind(null, bound, size);
      extrasType = kArrayExtrasType;
    } else if (types.isMapIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces("Map", tag);
      // Add braces to the formatter parameters.
      (formatter) = formatIterator.bind(null, braces);
    } else if (types.isSetIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces("Set", tag);
      // Add braces to the formatter parameters.
      (formatter) = formatIterator.bind(null, braces);
    } else {
      noIterator = true;
    }
  }
  if (noIterator) {
    keys = getKeys(value, ctx.showHidden);
    braces = ["{", "}"];
    if (constructor === "Object") {
      if (types.isArgumentsObject(value)) {
        braces[0] = "[Arguments] {";
      } else if (tag !== "") {
        braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
      }
      if (keys.length === 0 && protoProps === undefined) {
        return `${braces[0]}}`;
      }
    } else if (typeof value === "function") {
      base = getFunctionBase(value, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) {
        return ctx.stylize(base, "special");
      }
    } else if (types.isRegExp(value)) {
      // Make RegExps say that they are RegExps
      base = RegExp(constructor !== null ? value : new RegExp(value))
        .toString();
      const prefix = getPrefix(constructor, tag, "RegExp");
      if (prefix !== "RegExp ") {
        base = `${prefix}${base}`;
      }
      if (
        (keys.length === 0 && protoProps === undefined) ||
        (recurseTimes > ctx.depth && ctx.depth !== null)
      ) {
        return ctx.stylize(base, "regexp");
      }
    } else if (types.isDate(value)) {
      // Make dates with properties first say the date
      base = Number.isNaN(value.getTime())
        ? value.toString()
        : value.toISOString(value);
      const prefix = getPrefix(constructor, tag, "Date");
      if (prefix !== "Date ") {
        base = `${prefix}${base}`;
      }
      if (keys.length === 0 && protoProps === undefined) {
        return ctx.stylize(base, "date");
      }
    } else if (value instanceof Error) {
      base = formatError(value, constructor, tag, ctx, keys);
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else if (types.isAnyArrayBuffer(value)) {
      // Fast path for ArrayBuffer and SharedArrayBuffer.
      // Can't do the same for DataView because it has a non-primitive
      // .buffer property that we need to recurse for.
      const arrayType = types.isArrayBuffer(value)
        ? "ArrayBuffer"
        : "SharedArrayBuffer";
      const prefix = getPrefix(constructor, tag, arrayType);
      if (typedArray === undefined) {
        (formatter) = formatArrayBuffer;
      } else if (keys.length === 0 && protoProps === undefined) {
        return prefix +
          `{ byteLength: ${formatNumber(ctx.stylize, value.byteLength)} }`;
      }
      braces[0] = `${prefix}{`;
      Array.prototype.unshift(keys, "byteLength");
    } else if (types.isDataView(value)) {
      braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
      // .buffer goes last, it's not a primitive like the others.
      Array.prototype.unshift(keys, "byteLength", "byteOffset", "buffer");
    } else if (types.isPromise(value)) {
      braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
      (formatter) = formatPromise;
    } else if (types.isWeakSet(value)) {
      braces[0] = `${getPrefix(constructor, tag, "WeakSet")}{`;
      (formatter) = ctx.showHidden ? formatWeakSet : formatWeakCollection;
    } else if (types.isWeakMap(value)) {
      braces[0] = `${getPrefix(constructor, tag, "WeakMap")}{`;
      (formatter) = ctx.showHidden ? formatWeakMap : formatWeakCollection;
    } else if (types.isModuleNamespaceObject(value)) {
      braces[0] = `${getPrefix(constructor, tag, "Module")}{`;
      // Special handle keys for namespace objects.
      (formatter) = formatNamespaceObject.bind(null, keys);
    } else if (types.isBoxedPrimitive(value)) {
      base = getBoxedBase(value, ctx, keys, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else {
      if (keys.length === 0 && protoProps === undefined) {
        // TODO(wafuwafu13): Implement
        // if (types.isExternal(value)) {
        //   const address = getExternalValue(value).toString(16);
        //   return ctx.stylize(`[External: ${address}]`, 'special');
        // }
        return `${getCtxStyle(value, constructor, tag)}{}`;
      }
      braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
    }
  }

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    let constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
    if (constructor !== null) {
      constructorName = `[${constructorName}]`;
    }
    return ctx.stylize(constructorName, "special");
  }
  recurseTimes += 1;

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output;
  const indentationLvl = ctx.indentationLvl;
  try {
    output = formatter(ctx, value, recurseTimes);
    for (i = 0; i < keys.length; i++) {
      output.push(
        formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
      );
    }
    if (protoProps !== undefined) {
      output.push(...protoProps);
    }
  } catch (err) {
    const constructorName = getCtxStyle(value, constructor, tag).slice(0, -1);
    return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
  }
  if (ctx.circular !== undefined) {
    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = ctx.stylize(`<ref *${index}>`, "special");
      // Add reference always to the very beginning of the output.
      if (ctx.compact !== true) {
        base = base === "" ? reference : `${reference} ${base}`;
      } else {
        braces[0] = `${reference} ${braces[0]}`;
      }
    }
  }
  ctx.seen.pop();

  if (ctx.sorted) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === kObjectType) {
      output = output.sort(comparator);
    } else if (keys.length > 1) {
      const sorted = output.slice(output.length - keys.length).sort(comparator);
      output.splice(output.length - keys.length, keys.length, ...sorted);
    }
  }

  const res = reduceToSingleString(
    ctx,
    output,
    base,
    braces,
    extrasType,
    recurseTimes,
    value,
  );
  const budget = ctx.budget[ctx.indentationLvl] || 0;
  const newLength = budget + res.length;
  ctx.budget[ctx.indentationLvl] = newLength;
  // If any indentationLvl exceeds this limit, limit further inspecting to the
  // minimum. Otherwise the recursive algorithm might continue inspecting the
  // object even though the maximum string size (~2 ** 28 on 32 bit systems and
  // ~2 ** 30 on 64 bit systems) exceeded. The actual output is not limited at
  // exactly 2 ** 27 but a bit higher. This depends on the object shape.
  // This limit also makes sure that huge objects don't block the event loop
  // significantly.
  if (newLength > 2 ** 27) {
    ctx.depth = -1;
  }
  return res;
}

const builtInObjects = new Set(
  Object.getOwnPropertyNames(globalThis).filter((e) =>
    /^[A-Z][a-zA-Z0-9]+$/.test(e)
  ),
);

function addPrototypeProperties(
  ctx,
  main,
  obj,
  recurseTimes,
  output,
) {
  let depth = 0;
  let keys;
  let keySet;
  do {
    if (depth !== 0 || main === obj) {
      obj = Object.getPrototypeOf(obj);
      // Stop as soon as a null prototype is encountered.
      if (obj === null) {
        return;
      }
      // Stop as soon as a built-in object type is detected.
      const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
      if (
        descriptor !== undefined &&
        typeof descriptor.value === "function" &&
        builtInObjects.has(descriptor.value.name)
      ) {
        return;
      }
    }

    if (depth === 0) {
      keySet = new Set();
    } else {
      Array.prototype.forEach(keys, (key) => keySet.add(key));
    }
    // Get all own property names and symbols.
    keys = Reflect.ownKeys(obj);
    Array.prototype.push(ctx.seen, main);
    for (const key of keys) {
      // Ignore the `constructor` property and keys that exist on layers above.
      if (
        key === "constructor" ||
        // deno-lint-ignore no-prototype-builtins
        main.hasOwnProperty(key) ||
        (depth !== 0 && keySet.has(key))
      ) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (typeof desc.value === "function") {
        continue;
      }
      const value = formatProperty(
        ctx,
        obj,
        recurseTimes,
        key,
        kObjectType,
        desc,
        main,
      );
      if (ctx.colors) {
        // Faint!
        Array.prototype.push(output, `\u001b[2m${value}\u001b[22m`);
      } else {
        Array.prototype.push(output, value);
      }
    }
    Array.prototype.pop(ctx.seen);
    // Limit the inspection to up to three prototype layers. Using `recurseTimes`
    // is not a good choice here, because it's as if the properties are declared
    // on the current object from the users perspective.
  } while (++depth !== 3);
}

function getConstructorName(
  obj,
  ctx,
  recurseTimes,
  protoProps,
) {
  let firstProto;
  const tmp = obj;
  while (obj || isUndetectableObject(obj)) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
    if (
      descriptor !== undefined &&
      typeof descriptor.value === "function" &&
      descriptor.value.name !== "" &&
      isInstanceof(tmp, descriptor.value)
    ) {
      if (
        protoProps !== undefined &&
        (firstProto !== obj ||
          !builtInObjects.has(descriptor.value.name))
      ) {
        addPrototypeProperties(
          ctx,
          tmp,
          firstProto || tmp,
          recurseTimes,
          protoProps,
        );
      }
      return descriptor.value.name;
    }

    obj = Object.getPrototypeOf(obj);
    if (firstProto === undefined) {
      firstProto = obj;
    }
  }

  if (firstProto === null) {
    return null;
  }

  // TODO(wafuwafu13): Implement
  // const res = internalGetConstructorName(tmp);
  const res = undefined;

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return `${res} <Complex prototype>`;
  }

  const protoConstr = getConstructorName(
    firstProto,
    ctx,
    recurseTimes + 1,
    protoProps,
  );

  if (protoConstr === null) {
    return `${res} <${
      inspect(firstProto, {
        ...ctx,
        customInspect: false,
        depth: -1,
      })
    }>`;
  }

  return `${res} <${protoConstr}>`;
}

function formatPrimitive(fn, value, ctx) {
  if (typeof value === "string") {
    let trailer = "";
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      value = value.slice(0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
    }
    if (
      ctx.compact !== true &&
      // TODO(BridgeAR): Add unicode support. Use the readline getStringWidth
      // function.
      value.length > kMinLineLength &&
      value.length > ctx.breakLength - ctx.indentationLvl - 4
    ) {
      return value
        .split(/(?<=\n)/)
        .map((line) => fn(strEscape(line), "string"))
        .join(` +\n${" ".repeat(ctx.indentationLvl + 2)}`) + trailer;
    }
    return fn(strEscape(value), "string") + trailer;
  }
  if (typeof value === "number") {
    return formatNumber(fn, value);
  }
  if (typeof value === "bigint") {
    return formatBigInt(fn, value);
  }
  if (typeof value === "boolean") {
    return fn(`${value}`, "boolean");
  }
  if (typeof value === "undefined") {
    return fn("undefined", "undefined");
  }
  // es6 symbol primitive
  return fn(value.toString(), "symbol");
}

// Return a new empty array to push in the results of the default formatter.
function getEmptyFormatArray() {
  return [];
}

function isInstanceof(object, proto) {
  try {
    return object instanceof proto;
  } catch {
    return false;
  }
}

function getPrefix(constructor, tag, fallback, size = "") {
  if (constructor === null) {
    if (tag !== "" && fallback !== tag) {
      return `[${fallback}${size}: null prototype] [${tag}] `;
    }
    return `[${fallback}${size}: null prototype] `;
  }

  if (tag !== "" && constructor !== tag) {
    return `${constructor}${size} [${tag}] `;
  }
  return `${constructor}${size} `;
}

function formatArray(ctx, value, recurseTimes) {
  const valLen = value.length;
  const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);

  const remaining = valLen - len;
  const output = [];
  for (let i = 0; i < len; i++) {
    // Special handle sparse arrays.
    // deno-lint-ignore no-prototype-builtins
    if (!value.hasOwnProperty(i)) {
      return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
    }
    output.push(formatProperty(ctx, value, recurseTimes, i, kArrayType));
  }
  if (remaining > 0) {
    output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
  }
  return output;
}

function getCtxStyle(_value, constructor, tag) {
  let fallback = "";
  if (constructor === null) {
    // TODO(wafuwafu13): Implement
    // fallback = internalGetConstructorName(value);
    if (fallback === tag) {
      fallback = "Object";
    }
  }
  return getPrefix(constructor, tag, fallback);
}

// Look up the keys of the object.
function getKeys(value, showHidden) {
  let keys;
  const symbols = Object.getOwnPropertySymbols(value);
  if (showHidden) {
    keys = Object.getOwnPropertyNames(value);
    if (symbols.length !== 0) {
      Array.prototype.push.apply(keys, symbols);
    }
  } else {
    // This might throw if `value` is a Module Namespace Object from an
    // unevaluated module, but we don't want to perform the actual type
    // check because it's expensive.
    // TODO(devsnek): track https://github.com/tc39/ecma262/issues/1209
    // and modify this logic as needed.
    try {
      keys = Object.keys(value);
    } catch (_err) {
      // TODO(wafuwafu13): Implement
      // assert(isNativeError(err) && err.name === 'ReferenceError' &&
      //        isModuleNamespaceObject(value));
      keys = Object.getOwnPropertyNames(value);
    }
    if (symbols.length !== 0) {
      // TODO(wafuwafu13): Implement
      // const filter = (key: any) =>
      //
      //   Object.prototype.propertyIsEnumerable(value, key);
      // Array.prototype.push.apply(
      //   keys,
      //   symbols.filter(filter),
      // );
    }
  }
  return keys;
}

function formatSet(value, ctx, _ignored, recurseTimes) {
  const output = [];
  ctx.indentationLvl += 2;
  for (const v of value) {
    Array.prototype.push(output, formatValue(ctx, v, recurseTimes));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatMap(value, ctx, _gnored, recurseTimes) {
  const output = [];
  ctx.indentationLvl += 2;
  for (const { 0: k, 1: v } of value) {
    output.push(
      `${formatValue(ctx, k, recurseTimes)} => ${
        formatValue(ctx, v, recurseTimes)
      }`,
    );
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatTypedArray(
  value,
  length,
  ctx,
  _ignored,
  recurseTimes,
) {
  const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
  const remaining = value.length - maxLength;
  const output = new Array(maxLength);
  const elementFormatter = value.length > 0 && typeof value[0] === "number"
    ? formatNumber
    : formatBigInt;
  for (let i = 0; i < maxLength; ++i) {
    output[i] = elementFormatter(ctx.stylize, value[i]);
  }
  if (remaining > 0) {
    output[maxLength] = `... ${remaining} more item${remaining > 1 ? "s" : ""}`;
  }
  if (ctx.showHidden) {
    // .buffer goes last, it's not a primitive like the others.
    // All besides `BYTES_PER_ELEMENT` are actually getters.
    ctx.indentationLvl += 2;
    for (
      const key of [
        "BYTES_PER_ELEMENT",
        "length",
        "byteLength",
        "byteOffset",
        "buffer",
      ]
    ) {
      const str = formatValue(ctx, value[key], recurseTimes, true);
      Array.prototype.push(output, `[${key}]: ${str}`);
    }
    ctx.indentationLvl -= 2;
  }
  return output;
}

function getIteratorBraces(type, tag) {
  if (tag !== `${type} Iterator`) {
    if (tag !== "") {
      tag += "] [";
    }
    tag += `${type} Iterator`;
  }
  return [`[${tag}] {`, "}"];
}

function formatIterator(braces, ctx, value, recurseTimes) {
  // TODO(wafuwafu13): Implement
  // const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
  const { 0: entries, 1: isKeyValue } = value;
  if (isKeyValue) {
    // Mark entry iterators as such.
    braces[0] = braces[0].replace(/ Iterator] {$/, " Entries] {");
    return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
  }

  return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
}

function getFunctionBase(value, constructor, tag) {
  const stringified = Function.prototype.toString(value);
  if (stringified.slice(0, 5) === "class" && stringified.endsWith("}")) {
    const slice = stringified.slice(5, -1);
    const bracketIndex = slice.indexOf("{");
    if (
      bracketIndex !== -1 &&
      (!slice.slice(0, bracketIndex).includes("(") ||
        // Slow path to guarantee that it's indeed a class.
        classRegExp.test(slice.replace(stripCommentsRegExp)))
    ) {
      return getClassBase(value, constructor, tag);
    }
  }
  let type = "Function";
  if (types.isGeneratorFunction(value)) {
    type = `Generator${type}`;
  }
  if (types.isAsyncFunction(value)) {
    type = `Async${type}`;
  }
  let base = `[${type}`;
  if (constructor === null) {
    base += " (null prototype)";
  }
  if (value.name === "") {
    base += " (anonymous)";
  } else {
    base += `: ${value.name}`;
  }
  base += "]";
  if (constructor !== type && constructor !== null) {
    base += ` ${constructor}`;
  }
  if (tag !== "" && constructor !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function formatError(
  err,
  constructor,
  tag,
  ctx,
  keys,
) {
  const name = err.name != null ? String(err.name) : "Error";
  let len = name.length;
  let stack = err.stack ? String(err.stack) : err.toString;

  // Do not "duplicate" error properties that are already included in the output
  // otherwise.
  if (!ctx.showHidden && keys.length !== 0) {
    for (const name of ["name", "message", "stack"]) {
      const index = keys.indexOf(name);
      // Only hide the property in case it's part of the original stack
      if (index !== -1 && stack.includes(err[name])) {
        keys.splice(index, 1);
      }
    }
  }

  // A stack trace may contain arbitrary data. Only manipulate the output
  // for "regular errors" (errors that "look normal") for now.
  if (
    constructor === null ||
    (name.endsWith("Error") &&
      stack.startsWith(name) &&
      (stack.length === len || stack[len] === ":" || stack[len] === "\n"))
  ) {
    let fallback = "Error";
    if (constructor === null) {
      const start = stack.match(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/) ||
        stack.match(/^([a-z_A-Z0-9-]*Error)$/);
      fallback = (start && start[1]) || "";
      len = fallback.length;
      fallback = fallback || "Error";
    }
    const prefix = getPrefix(constructor, tag, fallback).slice(0, -1);
    if (name !== prefix) {
      if (prefix.includes(name)) {
        if (len === 0) {
          stack = `${prefix}: ${stack}`;
        } else {
          stack = `${prefix}${stack.slice(len)}`;
        }
      } else {
        stack = `${prefix} [${name}]${stack.slice(len)}`;
      }
    }
  }
  // Ignore the error message if it's contained in the stack.
  let pos = (err.message && stack.indexOf(err.message)) || -1;
  if (pos !== -1) {
    pos += err.message.length;
  }
  // Wrap the error in brackets in case it has no stack trace.
  const stackStart = stack.indexOf("\n    at", pos);
  if (stackStart === -1) {
    stack = `[${stack}]`;
  } else if (ctx.colors) {
    // Highlight userland code and node modules.
    let newStack = stack.slice(0, stackStart);
    const lines = stack.slice(stackStart + 1).split("\n");
    for (const line of lines) {
      // const core = line.match(coreModuleRegExp);
      // TODO(wafuwafu13): Implement
      // if (core !== null && NativeModule.exists(core[1])) {
      //   newStack += `\n${ctx.stylize(line, 'undefined')}`;
      // } else {
      // This adds underscores to all node_modules to quickly identify them.
      let nodeModule;
      newStack += "\n";
      let pos = 0;
      // deno-lint-ignore no-cond-assign
      while (nodeModule = nodeModulesRegExp.exec(line)) {
        // '/node_modules/'.length === 14
        newStack += line.slice(pos, nodeModule.index + 14);
        newStack += ctx.stylize(nodeModule[1], "module");
        pos = nodeModule.index + nodeModule[0].length;
      }
      newStack += pos === 0 ? line : line.slice(pos);
      // }
    }
    stack = newStack;
  }
  // The message and the stack have to be indented as well!
  if (ctx.indentationLvl !== 0) {
    const indentation = " ".repeat(ctx.indentationLvl);
    stack = stack.replace(/\n/g, `\n${indentation}`);
  }
  return stack;
}

let hexSlice;

function formatArrayBuffer(ctx, value) {
  let buffer;
  try {
    buffer = new Uint8Array(value);
  } catch {
    return [ctx.stylize("(detached)", "special")];
  }
  // TODO(wafuwafu13): Implement
  // if (hexSlice === undefined)
  //   hexSlice = uncurryThis(require('buffer').Buffer.prototype.hexSlice);
  let str = hexSlice(buffer, 0, Math.min(ctx.maxArrayLength, buffer.length))
    .replace(/(.{2})/g, "$1 ").trim();

  const remaining = buffer.length - ctx.maxArrayLength;
  if (remaining > 0) {
    str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
  }
  return [`${ctx.stylize("[Uint8Contents]", "special")}: <${str}>`];
}

function formatNumber(fn, value) {
  // Format -0 as '-0'. Checking `value === -0` won't distinguish 0 from -0.
  return fn(Object.is(value, -0) ? "-0" : `${value}`, "number");
}

function formatPromise(ctx, value, recurseTimes) {
  let output;
  // TODO(wafuwafu13): Implement
  // const { 0: state, 1: result } = getPromiseDetails(value);
  const { 0: state, 1: result } = value;
  if (state === kPending) {
    output = [ctx.stylize("<pending>", "special")];
  } else {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, result, recurseTimes);
    ctx.indentationLvl -= 2;
    output = [
      state === kRejected
        ? `${ctx.stylize("<rejected>", "special")} ${str}`
        : str,
    ];
  }
  return output;
}

function formatWeakCollection(ctx) {
  return [ctx.stylize("<items unknown>", "special")];
}

function formatWeakSet(ctx, value, recurseTimes) {
  // TODO(wafuwafu13): Implement
  // const entries = previewEntries(value);
  const entries = value;
  return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatWeakMap(ctx, value, recurseTimes) {
  // TODO(wafuwafu13): Implement
  // const entries = previewEntries(value);
  const entries = value;
  return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatProperty(
  ctx,
  value,
  recurseTimes,
  key,
  type,
  desc,
  original = value,
) {
  let name, str;
  let extra = " ";
  desc = desc || Object.getOwnPropertyDescriptor(value, key) ||
    { value: value[key], enumerable: true };
  if (desc.value !== undefined) {
    const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes);
    if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
      extra = `\n${" ".repeat(ctx.indentationLvl)}`;
    }
    ctx.indentationLvl -= diff;
  } else if (desc.get !== undefined) {
    const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
    const s = ctx.stylize;
    const sp = "special";
    if (
      ctx.getters && (ctx.getters === true ||
        (ctx.getters === "get" && desc.set === undefined) ||
        (ctx.getters === "set" && desc.set !== undefined))
    ) {
      try {
        const tmp = desc.get.call(original);
        ctx.indentationLvl += 2;
        if (tmp === null) {
          str = `${s(`[${label}:`, sp)} ${s("null", "null")}${s("]", sp)}`;
        } else if (typeof tmp === "object") {
          str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
        } else {
          const primitive = formatPrimitive(s, tmp, ctx);
          str = `${s(`[${label}:`, sp)} ${primitive}${s("]", sp)}`;
        }
        ctx.indentationLvl -= 2;
      } catch (err) {
        const message = `<Inspection threw (${err.message})>`;
        str = `${s(`[${label}:`, sp)} ${message}${s("]", sp)}`;
      }
    } else {
      str = ctx.stylize(`[${label}]`, sp);
    }
  } else if (desc.set !== undefined) {
    str = ctx.stylize("[Setter]", "special");
  } else {
    str = ctx.stylize("undefined", "undefined");
  }
  if (type === kArrayType) {
    return str;
  }
  if (typeof key === "symbol") {
    const tmp = key.toString().replace(strEscapeSequencesReplacer, escapeFn);

    name = `[${ctx.stylize(tmp, "symbol")}]`;
  } else if (key === "__proto__") {
    name = "['__proto__']";
  } else if (desc.enumerable === false) {
    const tmp = key.replace(strEscapeSequencesReplacer, escapeFn);

    name = `[${tmp}]`;
  } else if (keyStrRegExp.test(key)) {
    name = ctx.stylize(key, "name");
  } else {
    name = ctx.stylize(strEscape(key), "string");
  }
  return `${name}:${extra}${str}`;
}

function handleMaxCallStackSize(
  _ctx,
  _err,
  _constructorName,
  _indentationLvl,
) {
  // TODO(wafuwafu13): Implement
  // if (types.isStackOverflowError(err)) {
  //   ctx.seen.pop();
  //   ctx.indentationLvl = indentationLvl;
  //   return ctx.stylize(
  //     `[${constructorName}: Inspection interrupted ` +
  //       'prematurely. Maximum call stack size exceeded.]',
  //     'special'
  //   );
  // }
  // /* c8 ignore next */
  // assert.fail(err.stack);
}

// deno-lint-ignore no-control-regex
const colorRegExp = /\u001b\[\d\d?m/g;
function removeColors(str) {
  return str.replace(colorRegExp, "");
}

function isBelowBreakLength(ctx, output, start, base) {
  // Each entry is separated by at least a comma. Thus, we start with a total
  // length of at least `output.length`. In addition, some cases have a
  // whitespace in-between each other that is added to the total as well.
  // TODO(BridgeAR): Add unicode support. Use the readline getStringWidth
  // function. Check the performance overhead and make it an opt-in in case it's
  // significant.
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength) {
    return false;
  }
  for (let i = 0; i < output.length; i++) {
    if (ctx.colors) {
      totalLength += removeColors(output[i]).length;
    } else {
      totalLength += output[i].length;
    }
    if (totalLength > ctx.breakLength) {
      return false;
    }
  }
  // Do not line up properties on the same line if `base` contains line breaks.
  return base === "" || !base.includes("\n");
}

function formatBigInt(fn, value) {
  return fn(`${value}n`, "bigint");
}

function formatNamespaceObject(
  keys,
  ctx,
  value,
  recurseTimes,
) {
  const output = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    try {
      output[i] = formatProperty(
        ctx,
        value,
        recurseTimes,
        keys[i],
        kObjectType,
      );
    } catch (_err) {
      // TODO(wafuwfu13): Implement
      // assert(isNativeError(err) && err.name === 'ReferenceError');
      // Use the existing functionality. This makes sure the indentation and
      // line breaks are always correct. Otherwise it is very difficult to keep
      // this aligned, even though this is a hacky way of dealing with this.
      const tmp = { [keys[i]]: "" };
      output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
      const pos = output[i].lastIndexOf(" ");
      // We have to find the last whitespace and have to replace that value as
      // it will be visualized as a regular string.
      output[i] = output[i].slice(0, pos + 1) +
        ctx.stylize("<uninitialized>", "special");
    }
  }
  // Reset the keys to an empty array. This prevents duplicated inspection.
  keys.length = 0;
  return output;
}

// The array is sparse and/or has extra keys
function formatSpecialArray(
  ctx,
  value,
  recurseTimes,
  maxLength,
  output,
  i,
) {
  const keys = Object.keys(value);
  let index = i;
  for (; i < keys.length && output.length < maxLength; i++) {
    const key = keys[i];
    const tmp = +key;
    // Arrays can only have up to 2^32 - 1 entries
    if (tmp > 2 ** 32 - 2) {
      break;
    }
    if (`${index}` !== key) {
      if (!numberRegExp.test(key)) {
        break;
      }
      const emptyItems = tmp - index;
      const ending = emptyItems > 1 ? "s" : "";
      const message = `<${emptyItems} empty item${ending}>`;
      output.push(ctx.stylize(message, "undefined"));
      index = tmp;
      if (output.length === maxLength) {
        break;
      }
    }
    output.push(formatProperty(ctx, value, recurseTimes, key, kArrayType));
    index++;
  }
  const remaining = value.length - index;
  if (output.length !== maxLength) {
    if (remaining > 0) {
      const ending = remaining > 1 ? "s" : "";
      const message = `<${remaining} empty item${ending}>`;
      output.push(ctx.stylize(message, "undefined"));
    }
  } else if (remaining > 0) {
    output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
  }
  return output;
}

function getBoxedBase(
  value,
  ctx,
  keys,
  constructor,
  tag,
) {
  let fn;
  let type;
  if (types.isNumberObject(value)) {
    fn = Number.prototype.valueOf;
    type = "Number";
  } else if (types.isStringObject(value)) {
    fn = String.prototype.valueOf;
    type = "String";
    // For boxed Strings, we have to remove the 0-n indexed entries,
    // since they just noisy up the output and are redundant
    // Make boxed primitive Strings look like such
    keys.splice(0, value.length);
  } else if (types.isBooleanObject(value)) {
    fn = Boolean.prototype.valueOf;
    type = "Boolean";
  } else if (types.isBigIntObject(value)) {
    fn = BigInt.prototype.valueOf;
    type = "BigInt";
  } else {
    fn = Symbol.prototype.valueOf;
    type = "Symbol";
  }
  let base = `[${type}`;
  if (type !== constructor) {
    if (constructor === null) {
      base += " (null prototype)";
    } else {
      base += ` (${constructor})`;
    }
  }

  base += `: ${formatPrimitive(stylizeNoColor, fn(value), ctx)}]`;
  if (tag !== "" && tag !== constructor) {
    base += ` [${tag}]`;
  }
  if (keys.length !== 0 || ctx.stylize === stylizeNoColor) {
    return base;
  }
  return ctx.stylize(base, type.toLowerCase());
}

function getClassBase(value, constructor, tag) {
  // deno-lint-ignore no-prototype-builtins
  const hasName = value.hasOwnProperty("name");
  const name = (hasName && value.name) || "(anonymous)";
  let base = `class ${name}`;
  if (constructor !== "Function" && constructor !== null) {
    base += ` [${constructor}]`;
  }
  if (tag !== "" && constructor !== tag) {
    base += ` [${tag}]`;
  }
  if (constructor !== null) {
    const superName = Object.getPrototypeOf(value).name;
    if (superName) {
      base += ` extends ${superName}`;
    }
  } else {
    base += " extends [null prototype]";
  }
  return `[${base}]`;
}

function reduceToSingleString(
  ctx,
  output,
  base,
  braces,
  extrasType,
  recurseTimes,
  value,
) {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === "number" && ctx.compact >= 1) {
      // Memorize the original output length. In case the output is grouped,
      // prevent lining up the entries on a single line.
      const entries = output.length;
      // Group array elements together if the array contains at least six
      // separate entries.
      if (extrasType === kArrayExtrasType && entries > 6) {
        output = groupArrayElements(ctx, output, value);
      }
      // `ctx.currentDepth` is set to the most inner depth of the currently
      // inspected object part while `recurseTimes` is the actual current depth
      // that is inspected.
      //
      // Example:
      //
      // const a = { first: [ 1, 2, 3 ], second: { inner: [ 1, 2, 3 ] } }
      //
      // The deepest depth of `a` is 2 (a.second.inner) and `a.first` has a max
      // depth of 1.
      //
      // Consolidate all entries of the local most inner depth up to
      // `ctx.compact`, as long as the properties are smaller than
      // `ctx.breakLength`.
      if (
        ctx.currentDepth - recurseTimes < ctx.compact &&
        entries === output.length
      ) {
        // Line up all entries on a single line in case the entries do not
        // exceed `breakLength`. Add 10 as constant to start next to all other
        // factors that may reduce `breakLength`.
        const start = output.length + ctx.indentationLvl +
          braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          return `${base ? `${base} ` : ""}${braces[0]} ${join(output, ", ")}` +
            ` ${braces[1]}`;
        }
      }
    }
    // Line up each entry on an individual line.
    const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ` +
      `${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // Line up all entries on a single line in case the entries do not exceed
  // `breakLength`.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ""} ${join(output, ", ")} ` +
      braces[1];
  }
  const indentation = " ".repeat(ctx.indentationLvl);
  // If the opening "brace" is too large, like in the case of "Set {",
  // we need to force the first item to be on the next line or the
  // items will not line up correctly.
  const ln = base === "" && braces[0].length === 1
    ? " "
    : `${base ? ` ${base}` : ""}\n${indentation}  `;
  // Line up each entry on an individual line.
  return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
}

// The built-in Array#join is slower in v8 6.0
function join(output, separator) {
  let str = "";
  if (output.length !== 0) {
    const lastIndex = output.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      // It is faster not to use a template string here
      str += output[i];
      str += separator;
    }
    str += output[lastIndex];
  }
  return str;
}

function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let i = 0;
  let outputLength = output.length;
  if (ctx.maxArrayLength < output.length) {
    // This makes sure the "... n more items" part is not taken into account.
    outputLength--;
  }
  const separatorSpace = 2; // Add 1 for the space and 1 for the separator.
  const dataLen = new Array(outputLength);
  // Calculate the total length of all output entries and the individual max
  // entries length of all output entries. We have to remove colors first,
  // otherwise the length would not be calculated properly.
  for (; i < outputLength; i++) {
    const len = getStringWidth(output[i], ctx.colors);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) {
      maxLength = len;
    }
  }
  // Add two to `maxLength` as we add a single whitespace character plus a comma
  // in-between two entries.
  const actualMax = maxLength + separatorSpace;
  // Check if at least three entries fit next to each other and prevent grouping
  // of arrays that contains entries of very different length (i.e., if a single
  // entry is longer than 1/5 of all other entries combined). Otherwise the
  // space in-between small entries would be enormous.
  if (
    actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
    (totalLength / actualMax > 5 || maxLength <= 6)
  ) {
    const approxCharHeights = 2.5;
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    // Dynamically check how many columns seem possible.
    const columns = Math.min(
      // Ideally a square should be drawn. We expect a character to be about 2.5
      // times as high as wide. This is the area formula to calculate a square
      // which contains n rectangles of size `actualMax * approxCharHeights`.
      // Divide that by `actualMax` to receive the correct number of columns.
      // The added bias increases the columns for short entries.
      Math.round(
        Math.sqrt(
          approxCharHeights * biasedMax * outputLength,
        ) / biasedMax,
      ),
      // Do not exceed the breakLength.
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      // Limit array grouping for small `compact` modes as the user requested
      // minimal grouping.
      ctx.compact * 4,
      // Limit the columns to a maximum of fifteen.
      15,
    );
    // Return with the original output if no grouping should happen.
    if (columns <= 1) {
      return output;
    }
    const tmp = [];
    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength) {
          lineMaxLength = dataLen[j];
        }
      }
      lineMaxLength += separatorSpace;
      maxLineLength[i] = lineMaxLength;
    }
    let order = String.prototype.padStart;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
          order = String.prototype.padEnd;
          break;
        }
      }
    }
    // Each iteration creates a single line of grouped entries.
    for (let i = 0; i < outputLength; i += columns) {
      // The last lines may contain less entries than columns.
      const max = Math.min(i + columns, outputLength);
      let str = "";
      let j = i;
      for (; j < max - 1; j++) {
        // Calculate extra color padding in case it's active. This has to be
        // done line by line as some lines might contain more colors than
        // others.
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += order(`${output[j]}, `, padding, " ");
      }
      if (order === String.prototype.padStart) {
        const padding = maxLineLength[j - i] +
          output[j].length -
          dataLen[j] -
          separatorSpace;
        str += output[j].padStart(padding, " ");
      } else {
        str += output[j];
      }
      Array.prototype.push(tmp, str);
    }
    if (ctx.maxArrayLength < output.length) {
      Array.prototype.push(tmp, output[outputLength]);
    }
    output = tmp;
  }
  return output;
}

function formatMapIterInner(
  ctx,
  recurseTimes,
  entries,
  state,
) {
  const maxArrayLength = Math.max(ctx.maxArrayLength, 0);
  // Entries exist as [key1, val1, key2, val2, ...]
  const len = entries.length / 2;
  const remaining = len - maxArrayLength;
  const maxLength = Math.min(maxArrayLength, len);
  let output = new Array(maxLength);
  let i = 0;
  ctx.indentationLvl += 2;
  if (state === kWeak) {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      output[i] = `${formatValue(ctx, entries[pos], recurseTimes)} => ${
        formatValue(ctx, entries[pos + 1], recurseTimes)
      }`;
    }
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    if (!ctx.sorted) {
      output = output.sort();
    }
  } else {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      const res = [
        formatValue(ctx, entries[pos], recurseTimes),
        formatValue(ctx, entries[pos + 1], recurseTimes),
      ];
      output[i] = reduceToSingleString(
        ctx,
        res,
        "",
        ["[", "]"],
        kArrayExtrasType,
        recurseTimes,
      );
    }
  }
  ctx.indentationLvl -= 2;
  if (remaining > 0) {
    output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
  }
  return output;
}

function formatSetIterInner(
  ctx,
  recurseTimes,
  entries,
  state,
) {
  const maxArrayLength = Math.max(ctx.maxArrayLength, 0);
  const maxLength = Math.min(maxArrayLength, entries.length);
  const output = new Array(maxLength);
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    output[i] = formatValue(ctx, entries[i], recurseTimes);
  }
  ctx.indentationLvl -= 2;
  if (state === kWeak && !ctx.sorted) {
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    output.sort();
  }
  const remaining = entries.length - maxLength;
  if (remaining > 0) {
    Array.prototype.push(
      output,
      `... ${remaining} more item${remaining > 1 ? "s" : ""}`,
    );
  }
  return output;
}

// Regex used for ansi escape code splitting
// Adopted from https://github.com/chalk/ansi-regex/blob/HEAD/index.js
// License: MIT, authors: @sindresorhus, Qix-, arjunmehta and LitoMore
// Matches all ansi escape code sequences in a string
const ansiPattern = "[\\u001B\\u009B][[\\]()#;?]*" +
  "(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*" +
  "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)" +
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";
const ansi = new RegExp(ansiPattern, "g");

/**
 * Returns the number of columns required to display the given string.
 */
export function getStringWidth(str, removeControlChars = true) {
  let width = 0;

  if (removeControlChars) {
    str = stripVTControlCharacters(str);
  }
  str = str.normalize("NFC");
  for (const char of str[Symbol.iterator]()) {
    const code = char.codePointAt(0);
    if (isFullWidthCodePoint(code)) {
      width += 2;
    } else if (!isZeroWidthCodePoint(code)) {
      width++;
    }
  }

  return width;
}

/**
 * Returns true if the character represented by a given
 * Unicode code point is full-width. Otherwise returns false.
 */
const isFullWidthCodePoint = (code) => {
  // Code points are partially derived from:
  // https://www.unicode.org/Public/UNIDATA/EastAsianWidth.txt
  return code >= 0x1100 && (
    code <= 0x115f || // Hangul Jamo
    code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
    code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
    // CJK Radicals Supplement .. Enclosed CJK Letters and Months
    (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
    // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
    (code >= 0x3250 && code <= 0x4dbf) ||
    // CJK Unified Ideographs .. Yi Radicals
    (code >= 0x4e00 && code <= 0xa4c6) ||
    // Hangul Jamo Extended-A
    (code >= 0xa960 && code <= 0xa97c) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7a3) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Vertical Forms
    (code >= 0xfe10 && code <= 0xfe19) ||
    // CJK Compatibility Forms .. Small Form Variants
    (code >= 0xfe30 && code <= 0xfe6b) ||
    // Halfwidth and Fullwidth Forms
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    // Kana Supplement
    (code >= 0x1b000 && code <= 0x1b001) ||
    // Enclosed Ideographic Supplement
    (code >= 0x1f200 && code <= 0x1f251) ||
    // Miscellaneous Symbols and Pictographs 0x1f300 - 0x1f5ff
    // Emoticons 0x1f600 - 0x1f64f
    (code >= 0x1f300 && code <= 0x1f64f) ||
    // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
    (code >= 0x20000 && code <= 0x3fffd)
  );
};

const isZeroWidthCodePoint = (code) => {
  return code <= 0x1F || // C0 control codes
    (code >= 0x7F && code <= 0x9F) || // C1 control codes
    (code >= 0x300 && code <= 0x36F) || // Combining Diacritical Marks
    (code >= 0x200B && code <= 0x200F) || // Modifying Invisible Characters
    // Combining Diacritical Marks for Symbols
    (code >= 0x20D0 && code <= 0x20FF) ||
    (code >= 0xFE00 && code <= 0xFE0F) || // Variation Selectors
    (code >= 0xFE20 && code <= 0xFE2F) || // Combining Half Marks
    (code >= 0xE0100 && code <= 0xE01EF); // Variation Selectors
};

/**
 * Remove all VT control characters. Use to estimate displayed string width.
 */
export function stripVTControlCharacters(str) {
  validateString(str, "str");

  return str.replace(ansi, "");
}

export default {
  getStringWidth,
  stripVTControlCharacters,
};
