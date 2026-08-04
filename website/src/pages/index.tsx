import type { ReactNode } from "react"
import Link from "@docusaurus/Link"
import Layout from "@theme/Layout"
import Heading from "@theme/Heading"
import ProofChain from "../components/ProofChain"
import styles from "./index.module.css"

/**
 * Structured as a verification report rather than a product page: a ledger of refusals, then a
 * ledger of limits. Both are read straight from the implemented behaviour, so nothing here
 * promises something the CLI does not do.
 */

const refusals: [string, string][] = [
  [
    "A selector that matches nothing",
    "npx playwright test --grep @missing exits 0. The tag must be present in the report, or the criterion fails.",
  ],
  [
    "A criterion with no oracle",
    "Never a silent skip. If you did not declare how it would be proven, it is not proven.",
  ],
  [
    "A test that passed on retry",
    "The first attempt must pass. Retries launder a flake into evidence.",
  ],
  [
    "A contract weakened to fit",
    "Against a base commit, removing a criterion, downgrading its class, or trading a tagged test for an exit code is refused before anything runs.",
  ],
  [
    "A command that edits its own proof",
    "Git state is captured before and after every command. Edit-until-green does not survive it.",
  ],
  [
    "The scaffold it generates",
    "dogfood init writes a contract that cannot pass until you map a real oracle. A scaffold that passes immediately proves nothing.",
  ],
]

const limits: [string, ReactNode][] = [
  [
    "It does not mean the software is correct",
    <>The criteria you declared were proven by the oracles you declared. A requirement you never wrote down is not covered.</>,
  ],
  [
    "Bare verification is not provenance",
    <>
      Checksums prove internal consistency. Only <code>verify --key</code>, against a public key you
      obtained independently, says who produced a bundle — a key read out of the bundle is not a
      trust anchor.
    </>,
  ],
  [
    "A contract is executable code you trust",
    <>Running one runs its shell commands. There is no sandbox. Review a contract as you would review a script.</>,
  ],
  [
    "Ignored files are outside the boundary",
    <>Mutation detection cannot see Git-ignored paths, and the report records that it could not.</>,
  ],
]

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroGrid}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>evidence gate · agent-written code</p>

          <Heading as="h1" className={styles.title}>
            Your tests passed.
            <br />
            <span className={styles.titleAccent}>Which claim did that prove?</span>
          </Heading>

          <p className={styles.lede}>
            An exit code cannot answer that, because it was never asked. Dogfood makes you bind each
            acceptance criterion to an exact test or an exact command, runs them under watch, and
            emits a checksummed, signable bundle that anyone can re-verify offline.
          </p>

          <div className={styles.actions}>
            <Link className={styles.primaryCta} to="/docs/contract">
              Write a contract
            </Link>
            <Link className={styles.secondaryCta} to="/docs/cli">
              CLI reference
            </Link>
          </div>

          <p className={styles.install}>
            <code>npm install --save-dev @proofofwork-agency/dogfood</code>
          </p>
        </div>

        <div className={styles.heroPanel}>
          <ProofChain />
        </div>
      </div>
    </header>
  )
}

function Ledger({
  label,
  title,
  lede,
  rows,
  tone,
}: {
  label: string
  title: string
  lede: string
  rows: [string, ReactNode][]
  tone: "fail" | "pass"
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{label}</span>
        <Heading as="h2">{title}</Heading>
        <p>{lede}</p>
      </div>

      <dl className={`${styles.ledger} ${styles[tone]}`}>
        {rows.map(([term, detail]) => (
          <div key={term} className={styles.row}>
            <dt>{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Closing() {
  return (
    <section className={styles.closing}>
      <div className={styles.closingInner}>
        <Heading as="h2">Start with one criterion</Heading>
        <p>
          Map a single acceptance criterion to a test you already have, and run it. Three runtime
          dependencies, offline verification, no daemon and no service — the tool that checks the
          evidence should not be larger than the thing it checks.
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryCta} to="/docs/cli">
            Read the CLI reference
          </Link>
          <Link className={styles.secondaryCta} to="/docs/examples">
            Runnable examples
          </Link>
        </div>
      </div>
    </section>
  )
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Evidence gate for agent-written code"
      description="Dogfood binds each acceptance criterion to an exact test or command, runs it under watch, and emits a signed bundle anyone can verify offline."
    >
      <Hero />
      <main>
        <Ledger
          label="refusals"
          title="What it will not let through"
          lede="A gate is defined by what it rejects. Each of these is enforced in code, and each has a regression test."
          rows={refusals.map(([term, detail]) => [term, <>{detail}</>] as [string, ReactNode])}
          tone="fail"
        />
        <Ledger
          label="limits"
          title="What a PASS does not mean"
          lede="Stated here, printed in the CLI output, and recorded inside the bundle itself."
          rows={limits}
          tone="pass"
        />
        <Closing />
      </main>
    </Layout>
  )
}
