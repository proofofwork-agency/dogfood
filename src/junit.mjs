/**
 * A JUnit-XML reader with no dependency and no general-purpose XML engine behind it.
 *
 * "JUnit XML" was never specified by the JUnit project. The shape every runner emits descends from
 * Apache Ant's XMLJUnitResultFormatter and each dialect differs a little, so there is no schema to
 * validate against. This reader is therefore deliberately narrow: it understands only the elements
 * an oracle needs, and refuses what it cannot account for instead of guessing.
 *
 * Two refusals are security rather than pedantry:
 *   - A document type declaration is rejected outright. Entity expansion ("billion laughs") is the
 *     classic XML denial of service, and the structural defence is to have no entity table at all:
 *     with no DOCTYPE accepted no entity can be declared, so decoding is a single non-recursive
 *     pass over the five predefined names plus numeric character references.
 *   - An attribute value is read to its closing quote by index, never by scanning ahead for ">", so
 *     a ">" inside a test name cannot terminate the tag early and smuggle markup into the document.
 *
 * The outcome of a testcase is read from its child elements, never from the counters on the
 * enclosing <testsuite>. A header claiming failures="0" over a body containing <failure> is a
 * thing real emitters produce, and the elements are the evidence.
 */

const MAX_DEPTH = 100;
const MAX_ELEMENTS = 2_000_000;
const ROOT_ELEMENTS = new Set(["testsuites", "testsuite"]);
const OUTCOME_ELEMENTS = new Set(["failure", "error", "skipped"]);
// Worse outcomes win, so a testcase carrying both <failure> and <skipped> is failed.
const OUTCOME_RANK = { passed: 0, skipped: 1, failed: 2, error: 3 };
const OUTCOME_FOR_ELEMENT = { failure: "failed", error: "error", skipped: "skipped" };
const PREDEFINED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;

export class JunitParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "JunitParseError";
  }
}

/**
 * Decode report bytes, honouring the byte-order marks Windows runners emit. Reading a UTF-16 file
 * as UTF-8 yields mojibake that parses as "no testcases", which would be a silent wrong answer.
 */
export function decodeJunitBuffer(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (utf16) {
    const payload = Buffer.from(bytes.subarray(2));
    if (payload.length % 2 !== 0) throw new JunitParseError("report is truncated UTF-16");
    // Node decodes little-endian only, so a big-endian payload is byte-swapped first.
    return (bytes[0] === 0xfe ? payload.swap16() : payload).toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

export function parseJunitXml(source) {
  const text = String(source);
  if (text.trim() === "") throw new JunitParseError("report is empty");

  const suites = [];
  const testcases = [];
  const stack = [];
  let root = null;
  let elements = 0;
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start === -1) break;
    index = start;

    // CDATA opens with "<!" too, so it is recognised before declarations are refused.
    if (text.startsWith("<!--", index)) { index = skipPast(text, index + 4, "-->", "comment"); continue; }
    if (text.startsWith("<![CDATA[", index)) { index = skipPast(text, index + 9, "]]>", "CDATA section"); continue; }
    if (text.startsWith("<?", index)) { index = skipPast(text, index + 2, "?>", "processing instruction"); continue; }
    if (text.startsWith("<!", index)) {
      throw new JunitParseError("report contains a document type or markup declaration");
    }

    const tag = readTag(text, index);
    index = tag.end;
    if (++elements > MAX_ELEMENTS) throw new JunitParseError("report contains too many elements");

    if (tag.closing) {
      const open = stack.pop();
      if (!open || open.name !== tag.name) throw new JunitParseError(`unbalanced </${tag.name}>`);
      continue;
    }

    if (root === null) {
      root = tag.name;
      if (!ROOT_ELEMENTS.has(root)) {
        throw new JunitParseError(`root element is <${root}>, not <testsuites> or <testsuite>`);
      }
    }

    let testcaseIndex = null;
    if (tag.name === "testsuite") {
      suites.push({
        name: tag.attributes.name ?? null,
        tests: toNumber(tag.attributes.tests),
        failures: toNumber(tag.attributes.failures),
        errors: toNumber(tag.attributes.errors),
        skipped: toNumber(tag.attributes.skipped),
      });
    } else if (tag.name === "testcase") {
      testcaseIndex = testcases.length;
      testcases.push({
        classname: tag.attributes.classname ?? null,
        name: tag.attributes.name ?? null,
        suite: enclosingSuite(stack),
        time: toNumber(tag.attributes.time),
        status: "passed",
      });
    } else if (OUTCOME_ELEMENTS.has(tag.name)) {
      // An outcome is charged to the nearest enclosing testcase; a stray one outside any testcase
      // belongs to no criterion and is ignored rather than guessed at.
      const enclosing = nearestTestcase(stack);
      if (enclosing !== null) applyOutcome(testcases[enclosing], tag.name);
    }

    if (!tag.selfClosing) {
      stack.push({ name: tag.name, testcaseIndex, suiteName: tag.name === "testsuite" ? tag.attributes.name ?? null : null });
      if (stack.length > MAX_DEPTH) throw new JunitParseError("report nesting is too deep");
    }
  }

  if (stack.length > 0) throw new JunitParseError(`unclosed <${stack.at(-1).name}>`);
  if (root === null) throw new JunitParseError("report contains no XML elements");
  return { root, suites, testcases };
}

/**
 * Stable identity for a selector, so the adapter and the scorer agree on one key. The encoding is
 * JSON because it has to be injective: any separator-and-sentinel scheme lets a classname that
 * happens to be the sentinel collide with an omitted one, and two oracles sharing a key means one
 * criterion is scored against the other's evidence.
 */
export function junitSelectorKey(selector) {
  return JSON.stringify([selector?.classname ?? null, selector?.name ?? ""]);
}

export function describeJunitSelector(selector) {
  const name = `name="${selector?.name ?? ""}"`;
  return selector?.classname == null ? name : `classname="${selector.classname}" ${name}`;
}

/**
 * A selector matching nothing is a FAIL, never a pass — that is the false green this adapter
 * exists to kill. Every match must pass, so a broader selector is a stricter claim.
 */
export function evaluateJunitCase(report, selector) {
  const key = junitSelectorKey(selector);
  const wantedName = selector?.name ?? null;
  const wantedClass = selector?.classname ?? null;
  const matches = (report?.testcases || []).filter((testcase) =>
    testcase.name === wantedName && (wantedClass === null || testcase.classname === wantedClass));

  if (matches.length === 0) {
    return {
      status: "fail",
      selector: key,
      detail: `JUnit report contains no testcase matching ${describeJunitSelector(selector)}`,
      matches: [],
    };
  }

  const failed = matches.filter((testcase) => testcase.status !== "passed");
  if (failed.length > 0) {
    const summary = failed.map((testcase) => `${testcase.classname ?? "(no classname)"} :: ${testcase.name} (${testcase.status})`).join(", ");
    return {
      status: "fail",
      selector: key,
      detail: `Not every testcase matching ${describeJunitSelector(selector)} passed: ${summary}`,
      matches,
    };
  }

  return {
    status: "pass",
    selector: key,
    detail: `${matches.length} matching testcase(s) passed`,
    matches,
  };
}

function applyOutcome(testcase, element) {
  const outcome = OUTCOME_FOR_ELEMENT[element];
  if (OUTCOME_RANK[outcome] > OUTCOME_RANK[testcase.status]) testcase.status = outcome;
}

function nearestTestcase(stack) {
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (stack[depth].testcaseIndex !== null) return stack[depth].testcaseIndex;
  }
  return null;
}

function enclosingSuite(stack) {
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (stack[depth].name === "testsuite") return stack[depth].suiteName;
  }
  return null;
}

function readTag(text, start) {
  const closing = text.startsWith("</", start);
  let index = start + (closing ? 2 : 1);
  const nameStart = index;
  while (index < text.length && !isSpace(text[index]) && text[index] !== ">" && text[index] !== "/") index++;
  const rawName = text.slice(nameStart, index);
  if (rawName === "") throw new JunitParseError("malformed tag");

  const attributes = Object.create(null);
  const seen = new Set();
  let selfClosing = false;
  let closed = false;
  while (index < text.length) {
    while (index < text.length && isSpace(text[index])) index++;
    if (index >= text.length) break;
    if (text[index] === ">") { index++; closed = true; break; }
    if (text[index] === "/" && text[index + 1] === ">") { selfClosing = true; index += 2; closed = true; break; }

    const attributeStart = index;
    while (index < text.length && !isSpace(text[index]) && text[index] !== "=" && text[index] !== ">" && text[index] !== "/") index++;
    const attributeName = text.slice(attributeStart, index);
    if (attributeName === "") throw new JunitParseError(`malformed attribute in <${rawName}>`);
    // A repeated attribute is invalid XML and is exactly how a second value would be smuggled
    // past a reader that keeps the last one; namespaced twins collapse to first-wins instead.
    if (seen.has(attributeName)) throw new JunitParseError(`duplicate attribute ${attributeName} in <${rawName}>`);
    seen.add(attributeName);

    while (index < text.length && isSpace(text[index])) index++;
    if (text[index] !== "=") {
      if (!(localName(attributeName) in attributes)) attributes[localName(attributeName)] = "";
      continue;
    }
    index++;
    while (index < text.length && isSpace(text[index])) index++;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") throw new JunitParseError(`attribute ${attributeName} in <${rawName}> is not quoted`);
    const valueEnd = text.indexOf(quote, index + 1);
    if (valueEnd === -1) throw new JunitParseError(`unterminated attribute value in <${rawName}>`);
    if (!(localName(attributeName) in attributes)) {
      attributes[localName(attributeName)] = decodeEntities(text.slice(index + 1, valueEnd));
    }
    index = valueEnd + 1;
  }

  if (!closed) throw new JunitParseError(`unterminated <${rawName}>`);
  if (closing && selfClosing) throw new JunitParseError(`malformed closing tag </${rawName}/>`);
  return { name: localName(rawName), closing, selfClosing, attributes, end: index };
}

function decodeEntities(value) {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_PATTERN, (match, decimal, hexadecimal, named) => {
    if (named) return PREDEFINED_ENTITIES[named];
    const code = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;
    return String.fromCodePoint(code);
  });
}

function skipPast(text, from, terminator, label) {
  const end = text.indexOf(terminator, from);
  if (end === -1) throw new JunitParseError(`unterminated ${label}`);
  return end + terminator.length;
}

function localName(name) {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function isSpace(character) {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function toNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
