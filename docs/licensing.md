# Licensing

Dogfood is licensed under the **Apache License 2.0** (`LICENSE`), with attribution in `NOTICE`.

## What ships

The published package contains **no third-party source code**. Everything under `bin/`, `src/`,
`schemas/`, `templates/`, `docs/` and `examples/` is original work.

## Runtime dependencies

Three direct, four transitive. All permissive, all compatible with Apache-2.0 redistribution:

| Package | Licence |
|---|---|
| `ajv` | MIT |
| `ajv-formats` | MIT |
| `yaml` | ISC |
| `fast-deep-equal` | MIT |
| `fast-uri` | BSD-3-Clause |
| `json-schema-traverse` | MIT |
| `require-from-string` | MIT |

No copyleft licence appears anywhere in the shipped tree. These are resolved by the package manager
at install time and are not vendored into this repository or the published tarball.

Adding a runtime dependency is a reviewed decision, not a routine one — see `CONTRIBUTING.md`.

## JUnit XML

Dogfood both writes `junit.xml` into every bundle and reads JUnit XML as evidence via the
`junit-xml` adapter. Neither creates a licence obligation, and the reason is worth stating plainly
because the name misleads.

**Dogfood ships no JUnit code.** It implements an independent reader and writer for a file format.
Reading a format does not distribute the software that emits it, any more than a CSV parser
distributes a spreadsheet application.

Three facts behind that:

1. **"JUnit XML" was never specified by the JUnit project.** The shape everyone emits descends from
   Apache Ant's `XMLJUnitResultFormatter` (Apache License 2.0) and spread by imitation. There is no
   canonical schema — only community reconstructions, each with its own licence and none
   authoritative. This is why runners disagree on details, and why `src/junit.mjs` is defensive.
2. **No JUnit library is linked, bundled, or required.** JUnit 4 is licensed under the Eclipse
   Public License 1.0 and JUnit 5 under EPL 2.0. Both are weak copyleft, and neither is triggered:
   there is no JUnit code in this product to be governed by them.
3. **No JUnit XSD is vendored.** Validating against a bundled schema would mean inheriting whichever
   community reconstruction was chosen, along with its licence and its opinion about a format that
   has no official one. The adapter uses a targeted scanner instead — a decision made for
   dependency and correctness reasons that happens to keep the licensing clean too.

## Trademarks

"JUnit", "pytest", "Vitest", "Jest", "Playwright", "Maven" and "Gradle" are the marks of their
respective owners. Dogfood names them descriptively, to say what it interoperates with. It is not
affiliated with, endorsed by, or derived from any of them.

## Contributions

Contributions are accepted under the Apache License 2.0, per section 5 of that licence: a
contribution submitted for inclusion is licensed under the same terms, with no additional
conditions, unless you state otherwise explicitly.
