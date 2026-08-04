import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeJunitBuffer,
  evaluateJunitCase,
  junitSelectorKey,
  JunitParseError,
  parseJunitXml,
} from "../src/junit.mjs";

const PASSING = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="example" tests="2" failures="0" errors="0" skipped="0">
  <testcase classname="checkout" name="rejects an expired card" time="0.01"/>
  <testcase classname="pricing" name="applies the bulk discount" time="0.02"/>
</testsuite>
`;

function parse(xml) {
  return parseJunitXml(xml);
}

test("reads testcases out of a flat report", () => {
  const report = parse(PASSING);
  assert.equal(report.root, "testsuite");
  assert.equal(report.testcases.length, 2);
  assert.deepEqual(report.testcases[0], {
    classname: "checkout",
    name: "rejects an expired card",
    suite: "example",
    time: 0.01,
    status: "passed",
  });
  assert.equal(report.suites[0].failures, 0);
});

test("reads nested testsuites and records the enclosing suite name", () => {
  const report = parse(`<testsuites>
    <testsuite name="outer">
      <testsuite name="inner">
        <testcase classname="a" name="deep"/>
      </testsuite>
    </testsuite>
  </testsuites>`);
  assert.equal(report.testcases.length, 1);
  assert.equal(report.testcases[0].suite, "inner");
});

test("outcome comes from child elements, not the testsuite counters", () => {
  // A header claiming a clean run over a body containing <failure> is a thing real emitters do.
  const report = parse(`<testsuite name="lying" tests="1" failures="0" errors="0">
    <testcase classname="a" name="b"><failure message="boom"/></testcase>
  </testsuite>`);
  assert.equal(report.testcases[0].status, "failed");
  assert.equal(report.suites[0].failures, 0, "the header is still reported verbatim");
  assert.equal(evaluateJunitCase(report, { classname: "a", name: "b" }).status, "fail");
});

test("error outranks failure outranks skipped", () => {
  const report = parse(`<testsuite name="s">
    <testcase classname="a" name="both"><failure message="x"/><skipped/></testcase>
    <testcase classname="a" name="worst"><skipped/><error message="y"/></testcase>
    <testcase classname="a" name="skip"><skipped/></testcase>
  </testsuite>`);
  assert.equal(report.testcases[0].status, "failed");
  assert.equal(report.testcases[1].status, "error");
  assert.equal(report.testcases[2].status, "skipped");
});

test("a failure element without a message attribute still fails the testcase", () => {
  const report = parse(`<testsuite name="s"><testcase classname="a" name="b"><failure/></testcase></testsuite>`);
  assert.equal(report.testcases[0].status, "failed");
});

test("a document type declaration is refused outright", () => {
  // Billion laughs: the defence is having no entity table at all, not counting expansions.
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<testsuite name="s"><testcase classname="a" name="&lol2;"/></testsuite>`;
  assert.throws(() => parse(laughs), (error) =>
    error instanceof JunitParseError && /document type/.test(error.message));
});

test("entity decoding is a single non-recursive pass over the predefined names", () => {
  const report = parse(`<testsuite name="s">
    <testcase classname="a" name="&lt;tag&gt; &amp; &quot;quoted&quot; &apos;x&apos;"/>
    <testcase classname="b" name="&amp;lt;"/>
    <testcase classname="c" name="&#65;&#x42;"/>
    <testcase classname="d" name="&unknown; kept"/>
  </testsuite>`);
  assert.equal(report.testcases[0].name, `<tag> & "quoted" 'x'`);
  assert.equal(report.testcases[1].name, "&lt;", "a decoded ampersand must not be decoded again");
  assert.equal(report.testcases[2].name, "AB");
  assert.equal(report.testcases[3].name, "&unknown; kept");
});

test("a numeric reference outside the Unicode range is left alone", () => {
  const report = parse(`<testsuite name="s"><testcase classname="a" name="&#1114112; &#xD800;"/></testsuite>`);
  assert.equal(report.testcases[0].name, "&#1114112; &#xD800;");
});

test("a greater-than inside an attribute value cannot terminate the tag", () => {
  const report = parse(`<testsuite name="s">
    <testcase classname="a" name="x > y and z"/>
    <testcase classname="b" name='single "quoted" value'/>
  </testsuite>`);
  assert.equal(report.testcases.length, 2);
  assert.equal(report.testcases[0].name, "x > y and z");
  assert.equal(report.testcases[1].name, 'single "quoted" value');
});

test("comments, CDATA and processing instructions are not mistaken for markup", () => {
  const report = parse(`<testsuite name="s">
    <!-- <testcase classname="ghost" name="from a comment"/> -->
    <testcase classname="a" name="real">
      <system-out><![CDATA[ <failure message="from CDATA"/> ]]></system-out>
    </testcase>
    <?ignore <testcase classname="ghost" name="from a PI"/> ?>
  </testsuite>`);
  assert.equal(report.testcases.length, 1, "only the real testcase counts");
  assert.equal(report.testcases[0].status, "passed", "markup inside CDATA is character data");
});

test("malformed documents are rejected rather than half-read", () => {
  const cases = [
    ["<testsuite name='s'><testcase classname='a' name='b'></testsuite>", /unbalanced/],
    ["<testsuite name='s'><testcase classname='a' name='b'/>", /unclosed/],
    ["<testsuite name='s'><testcase classname='a' name='b", /unterminated/],
    ["<testsuite name='s'><!-- never closed", /unterminated comment/],
    ["<testsuite name='s'><testcase name=unquoted/></testsuite>", /not quoted/],
    ["<testsuite name='s'><testcase name='a' name='b'/></testsuite>", /duplicate attribute/],
    ["<html><body>not a report</body></html>", /root element is <html>/],
    ["", /report is empty/],
    ["   \n  ", /report is empty/],
  ];
  for (const [xml, expected] of cases) {
    assert.throws(() => parse(xml), (error) =>
      error instanceof JunitParseError && expected.test(error.message), `expected ${expected} for ${xml}`);
  }
});

test("namespaced elements and attributes resolve to their local names", () => {
  const report = parse(`<ns:testsuite xmlns:ns="urn:x" ns:name="s">
    <ns:testcase ns:classname="a" ns:name="b"><ns:failure ns:message="x"/></ns:testcase>
  </ns:testsuite>`);
  assert.equal(report.testcases.length, 1);
  assert.equal(report.testcases[0].classname, "a");
  assert.equal(report.testcases[0].status, "failed");
});

test("deep nesting is bounded", () => {
  const depth = 200;
  const xml = `<testsuites>${"<testsuite name='x'>".repeat(depth)}${"</testsuite>".repeat(depth)}</testsuites>`;
  assert.throws(() => parse(xml), (error) => error instanceof JunitParseError && /too deep/.test(error.message));
});

test("byte order marks decode instead of turning into a silently empty report", () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PASSING, "utf8")]);
  assert.equal(parse(decodeJunitBuffer(utf8)).testcases.length, 2);

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PASSING, "utf16le")]);
  assert.equal(parse(decodeJunitBuffer(utf16le)).testcases.length, 2);

  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(PASSING, "utf16le").swap16()]);
  assert.equal(parse(decodeJunitBuffer(utf16be)).testcases.length, 2);

  assert.throws(() => decodeJunitBuffer(Buffer.from([0xff, 0xfe, 0x41])), JunitParseError);
});

test("decodeJunitBuffer does not mutate the caller's buffer", () => {
  const source = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(PASSING, "utf16le").swap16()]);
  const before = Buffer.from(source);
  decodeJunitBuffer(source);
  assert.deepEqual(source, before);
});

test("a selector matching nothing is a fail, never a pass", () => {
  const report = parse(PASSING);
  for (const selector of [
    { classname: "checkout", name: "no such test" },
    { classname: "no such class", name: "rejects an expired card" },
    { classname: "checkout", name: "REJECTS AN EXPIRED CARD" },
    { classname: "checkout", name: " rejects an expired card " },
    { classname: "checkout", name: "" },
  ]) {
    const result = evaluateJunitCase(report, selector);
    assert.equal(result.status, "fail", `${JSON.stringify(selector)} must not pass`);
    assert.match(result.detail, /no testcase matching/);
  }
});

test("an empty report parses and proves nothing", () => {
  const report = parse("<testsuites/>");
  assert.equal(report.testcases.length, 0);
  assert.equal(evaluateJunitCase(report, { name: "anything" }).status, "fail");
});

test("omitting classname matches on name alone and requires every match to pass", () => {
  const report = parse(`<testsuite name="s">
    <testcase classname="a" name="shared"/>
    <testcase classname="b" name="shared"><failure message="x"/></testcase>
  </testsuite>`);
  const wide = evaluateJunitCase(report, { name: "shared" });
  assert.equal(wide.status, "fail", "a broader selector is a stricter claim, not a weaker one");
  assert.equal(wide.matches.length, 2);

  const narrow = evaluateJunitCase(report, { classname: "a", name: "shared" });
  assert.equal(narrow.status, "pass");
  assert.equal(narrow.matches.length, 1);
});

test("a skipped testcase never counts as proof", () => {
  const report = parse(`<testsuite name="s"><testcase classname="a" name="b"><skipped message="no browser"/></testcase></testsuite>`);
  const result = evaluateJunitCase(report, { classname: "a", name: "b" });
  assert.equal(result.status, "fail");
  assert.match(result.detail, /skipped/);
});

test("a re-run testcase must pass in every appearance", () => {
  const report = parse(`<testsuite name="s">
    <testcase classname="a" name="flaky"><failure message="first attempt"/></testcase>
    <testcase classname="a" name="flaky"/>
  </testsuite>`);
  assert.equal(evaluateJunitCase(report, { classname: "a", name: "flaky" }).status, "fail");
});

test("junitSelectorKey is injective, so no two selectors share evidence", () => {
  assert.equal(junitSelectorKey({ classname: "a", name: "b" }), junitSelectorKey({ classname: "a", name: "b" }));
  const distinct = [
    { name: "b" },
    { classname: "*", name: "b" },
    { classname: "a", name: "b" },
    { classname: "a::b", name: "" },
    { classname: "a", name: '"b"' },
    { classname: 'a","b', name: "" },
  ].map(junitSelectorKey);
  assert.equal(new Set(distinct).size, distinct.length, "every distinct selector needs a distinct key");
});
