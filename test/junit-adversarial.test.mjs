import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJunitCase, JunitParseError, parseJunitXml } from "../src/junit.mjs";

/**
 * Adversarial coverage for the hand-rolled scanner in src/junit.mjs.
 *
 * One property matters above all the others: **a testcase carrying a failure marker must never be
 * reported as passed.** Everything else in this file — crashes, hangs, false reds — is a defect
 * worth fixing, but a false green is the only class that makes the tool lie about a release.
 *
 * The generator is a seeded LCG rather than Math.random so a failure reproduces exactly.
 */

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Either it throws JunitParseError, or it returns a report. Nothing else is acceptable. */
function parseOrRefuse(xml) {
  try {
    return { report: parseJunitXml(xml), refused: false };
  } catch (error) {
    assert.ok(
      error instanceof JunitParseError,
      `must refuse with JunitParseError, got ${error?.name}: ${error?.message}\ninput: ${xml.slice(0, 200)}`,
    );
    return { report: null, refused: true };
  }
}

const HOSTILE = [
  // Truncation at every structural boundary.
  "<testsuite",
  "<testsuite ",
  "<testsuite name",
  "<testsuite name=",
  "<testsuite name='",
  "<testsuite name='s'",
  "<testsuite name='s'>",
  "<testsuite name='s'><testcase",
  "<testsuite name='s'><testcase name='a'",
  "<testsuite name='s'><testcase name='a'/",
  "<testsuite name='s'><testcase name='a'/>",
  "<testsuite name='s'><testcase name='a'/></",
  "<testsuite name='s'><testcase name='a'/></testsuite",
  // Comment and CDATA interleaving.
  "<testsuite name='s'><!-- <![CDATA[ --></testsuite>",
  "<testsuite name='s'><![CDATA[ <!-- ]]></testsuite>",
  "<testsuite name='s'><!-- unclosed CDATA <![CDATA[ --></testsuite>",
  "<testsuite name='s'><![CDATA[]]]]><![CDATA[>]]></testsuite>",
  "<testsuite name='s'><!----></testsuite>",
  "<testsuite name='s'><!-- -- --></testsuite>",
  // Declarations of every shape.
  "<!DOCTYPE testsuite><testsuite name='s'/>",
  "<!DOCTYPE testsuite SYSTEM 'x.dtd'><testsuite name='s'/>",
  "<!ENTITY x 'y'><testsuite name='s'/>",
  "<![INCLUDE[<testsuite name='s'/>]]>",
  // Processing instructions and declarations in odd places.
  "<?xml version='1.0'?><?php evil(); ?><testsuite name='s'/>",
  "<testsuite name='s'><?pi <testcase name='ghost'/> ?></testsuite>",
  // Attribute edge cases.
  `<testsuite name='s'><testcase name='a' name='b'/></testsuite>`,
  `<testsuite name='s'><testcase ='novalue'/></testsuite>`,
  `<testsuite name='s'><testcase name=='x'/></testsuite>`,
  `<testsuite name='s'><testcase name="]]>"/></testsuite>`,
  `<testsuite name='s'><testcase name="a'b" classname='c"d'/></testsuite>`,
  `<testsuite name='s'><testcase name="&#0;"/></testsuite>`,
  `<testsuite name='s'><testcase name="&#x110000;"/></testsuite>`,
  `<testsuite name='s'><testcase name="&#xD800;&#xDC00;"/></testsuite>`,
  `<testsuite name='s'><testcase name="&&&&&"/></testsuite>`,
  `<testsuite name='s'><testcase name="&amp;#60;"/></testsuite>`,
  // Structure.
  "<testsuite name='s'></testcase></testsuite>",
  "<testsuite name='s'><testcase name='a'></testsuite></testcase>",
  "<testsuites><testsuite name='s'/></testsuites></testsuites>",
  "<testcase name='orphan'/>",
  "<testsuites/>",
  "<testsuite/>",
  // Whitespace and separators.
  "<testsuite\tname='s'\n><testcase\r\nname='a'\t/></testsuite>",
  "<testsuite name='s'><testcase name='   '/></testsuite>",
  "<testsuite name='s'><testcase name=''/></testsuite>",
  // Junk around a valid document.
  "﻿<testsuite name='s'><testcase name='a'/></testsuite>",
  "garbage<testsuite name='s'><testcase name='a'/></testsuite>",
  "<testsuite name='s'><testcase name='a'/></testsuite>trailing",
];

test("no hostile input crashes, hangs, or escapes JunitParseError", () => {
  for (const xml of HOSTILE) {
    const started = Date.now();
    parseOrRefuse(xml);
    assert.ok(Date.now() - started < 2000, `parsing took too long: ${xml.slice(0, 80)}`);
  }
});

test("a failure marker is never lost, in any syntactic form", () => {
  // Every one of these testcases carries a failure marker somewhere inside it. If any variation
  // parses to "passed", a broken build reports green — the one outcome that must be impossible.
  const variations = [
    `<failure/>`,
    `<failure></failure>`,
    `<failure message="x"/>`,
    `<failure message="x">detail</failure>`,
    `<failure><![CDATA[ nested ]]></failure>`,
    `<failure message="]]>"/>`,
    `<failure message="a > b"/>`,
    `<failure\n  message="multi\nline"\n/>`,
    `<ns:failure xmlns:ns="urn:x"/>`,
    `<error/>`,
    `<error message="boom"/>`,
    `<ns:error xmlns:ns="urn:x"/>`,
    `<skipped/>`,
    `<skipped message="no browser"/>`,
    `<system-out>ok</system-out><failure message="after other children"/>`,
    `<failure message="before"/><system-out>ok</system-out>`,
    `<properties><property name="p" value="v"/></properties><failure/>`,
  ];

  for (const marker of variations) {
    const xml = `<testsuite name="s" tests="1" failures="0" errors="0" skipped="0">
      <testcase classname="c" name="t">${marker}</testcase>
    </testsuite>`;
    const { report, refused } = parseOrRefuse(xml);
    if (refused) continue; // refusing is a safe outcome; passing is not
    assert.equal(report.testcases.length, 1, marker);
    assert.notEqual(report.testcases[0].status, "passed", `marker lost: ${marker}`);
    assert.equal(
      evaluateJunitCase(report, { classname: "c", name: "t" }).status,
      "fail",
      `false green for: ${marker}`,
    );
  }
});

test("a lying testsuite header never rescues a failing testcase", () => {
  for (const header of [
    `tests="1" failures="0" errors="0" skipped="0"`,
    `tests="0" failures="0"`,
    ``,
    `tests="999" failures="999"`,
  ]) {
    const xml = `<testsuite name="s" ${header}><testcase classname="c" name="t"><failure/></testcase></testsuite>`;
    const { report } = parseOrRefuse(xml);
    assert.equal(evaluateJunitCase(report, { classname: "c", name: "t" }).status, "fail", header);
  }
});

test("the same testcase under two suites requires both to pass", () => {
  const xml = `<testsuites>
    <testsuite name="alpha"><testcase classname="c" name="t"/></testsuite>
    <testsuite name="beta"><testcase classname="c" name="t"><failure message="only here"/></testcase></testsuite>
  </testsuites>`;
  const { report } = parseOrRefuse(xml);
  assert.equal(report.testcases.length, 2);
  const result = evaluateJunitCase(report, { classname: "c", name: "t" });
  assert.equal(result.status, "fail", "a duplicate name must not let the passing copy stand in");
});

test("a failure element outside any testcase is not charged to a neighbour", () => {
  // A false red is a lesser sin than a false green, but it is still wrong: the passing testcase
  // here is a sibling of the stray marker, not its parent.
  const xml = `<testsuite name="s">
    <testcase classname="c" name="passing"/>
    <failure message="stray, belongs to no testcase"/>
  </testsuite>`;
  const { report } = parseOrRefuse(xml);
  assert.equal(report.testcases[0].status, "passed");
  assert.equal(evaluateJunitCase(report, { classname: "c", name: "passing" }).status, "pass");
});

test("a genuinely passing report is not refused by any of the dialects runners emit", () => {
  // The false-red direction. Each of these is a real emitter's shape and must parse and pass.
  const dialects = [
    // pytest
    `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1" time="0.01" timestamp="2026-01-01T00:00:00.000000" hostname="h"><testcase classname="tests.test_checkout" name="test_ok" time="0.001"/></testsuite></testsuites>`,
    // Vitest / jest-junit
    `<?xml version="1.0" encoding="UTF-8"?><testsuites name="vitest" tests="1" failures="0" errors="0" time="0.1"><testsuite name="src/a.test.ts" timestamp="2026-01-01T00:00:00" hostname="h" tests="1" failures="0" errors="0" skipped="0" time="0.1"><testcase classname="src/a.test.ts" name="works" time="0.05"/></testsuite></testsuites>`,
    // gotestsum
    `<testsuites tests="1" failures="0"><testsuite tests="1" failures="0" time="0.010" name="pkg/x"><properties><property name="go.version" value="go1.24"/></properties><testcase classname="pkg/x" name="TestOK" time="0.010"/></testsuite></testsuites>`,
    // Maven surefire
    `<?xml version="1.0" encoding="UTF-8"?><testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="com.example.AppTest" time="0.05" tests="1" errors="0" skipped="0" failures="0"><properties><property name="java.version" value="21"/></properties><testcase name="ok" classname="com.example.AppTest" time="0.01"><system-out><![CDATA[hello]]></system-out></testcase></testsuite>`,
    // PHPUnit
    `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="Unit" tests="1" assertions="1" errors="0" failures="0" skipped="0" time="0.001"><testcase name="testOk" class="AppTest" classname="AppTest" file="/x/AppTest.php" line="8" assertions="1" time="0.001"/></testsuite></testsuites>`,
    // RSpec
    `<?xml version="1.0" encoding="UTF-8"?><testsuite name="rspec" tests="1" skipped="0" failures="0" errors="0" time="0.01" timestamp="2026-01-01T00:00:00+00:00"><properties/><testcase classname="spec.models.user_spec" name="User is valid" file="./spec/models/user_spec.rb" time="0.001"/></testsuite>`,
  ];

  for (const xml of dialects) {
    const report = parseJunitXml(xml);
    assert.ok(report.testcases.length >= 1, `no testcases parsed from: ${xml.slice(0, 90)}`);
    const first = report.testcases[0];
    assert.equal(first.status, "passed", xml.slice(0, 90));
    assert.equal(evaluateJunitCase(report, { classname: first.classname, name: first.name }).status, "pass");
  }
});

test("randomly corrupted valid reports never produce a false green", () => {
  const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="outer" tests="3" failures="1">
    <testcase classname="c" name="alpha" time="0.1"/>
    <testcase classname="c" name="beta"><failure message="expected 1 got 2"/></testcase>
    <testcase classname="c" name="gamma"><system-out><![CDATA[noise <failure/> noise]]></system-out></testcase>
  </testsuite>
</testsuites>`;

  const random = lcg(0x5eed);
  const mutations = [
    (s, i) => s.slice(0, i) + s.slice(i + 1),
    (s, i) => s.slice(0, i) + "<" + s.slice(i),
    (s, i) => s.slice(0, i) + ">" + s.slice(i),
    (s, i) => s.slice(0, i) + '"' + s.slice(i),
    (s, i) => s.slice(0, i) + "&" + s.slice(i),
    (s, i) => s.slice(0, i) + "]]>" + s.slice(i),
    (s, i) => s.slice(0, i),
  ];

  for (let iteration = 0; iteration < 3000; iteration++) {
    let xml = VALID;
    const edits = 1 + Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit++) {
      const mutate = mutations[Math.floor(random() * mutations.length)];
      xml = mutate(xml, Math.floor(random() * Math.max(1, xml.length)));
    }

    const { report, refused } = parseOrRefuse(xml);
    if (refused || report.testcases.length === 0) continue;

    // "beta" carries a failure. Corruption may erase it, rename it, or make the document
    // unparseable — all fine. What must never happen is beta surviving intact and reported green.
    const beta = report.testcases.find((testcase) => testcase.name === "beta" && testcase.classname === "c");
    if (!beta) continue;
    if (xml.includes(`<testcase classname="c" name="beta"><failure message="expected 1 got 2"/>`)) {
      assert.notEqual(beta.status, "passed", `false green after mutation:\n${xml}`);
    }
  }
});
