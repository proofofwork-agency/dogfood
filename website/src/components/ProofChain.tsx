import { useEffect, useReducer, useRef, type ReactNode } from "react"
import styles from "./ProofChain.module.css"

/**
 * The hero dramatizes the one thing this tool does that a test runner does not: it refuses a green
 * that nobody proved. Two runs alternate — a fabricated pass being caught, then a real one being
 * sealed — because showing only the happy path would sell the same story as every other CI badge.
 *
 * Nothing here is load-bearing: the copy below the animation states the same claims in text, and
 * prefers-reduced-motion pins the panel to its final frame.
 */

type Step = {
  label: string
  detail: string
  tone: "neutral" | "pass" | "fail"
}

type Scenario = {
  id: string
  command: string
  claim: string
  steps: Step[]
  verdict: "PASS" | "FAIL"
  moral: ReactNode
}

const SCENARIOS: Scenario[] = [
  {
    id: "caught",
    command: "npx playwright test --grep @checkout",
    claim: "12 passed (4.1s)",
    steps: [
      { label: "criterion", detail: "AC-checkout — a customer can complete a purchase", tone: "neutral" },
      { label: "oracle", detail: "playwright tag @dogfood:AC-checkout", tone: "neutral" },
      { label: "evidence", detail: "report contains 12 results, none carrying that tag", tone: "fail" },
      { label: "verdict", detail: "the suite exited 0 and proved nothing about AC-checkout", tone: "fail" },
    ],
    verdict: "FAIL",
    moral: (
      <>
        A <code>--grep</code> that matches nothing still exits <code>0</code>. That is the most common
        false green in agent-written CI, and an exit code cannot see it.
      </>
    ),
  },
  {
    id: "proven",
    command: "npx playwright test --reporter=json",
    claim: "1 passed, first attempt",
    steps: [
      { label: "criterion", detail: "AC-checkout — a customer can complete a purchase", tone: "neutral" },
      { label: "oracle", detail: "playwright tag @dogfood:AC-checkout", tone: "neutral" },
      { label: "evidence", detail: "tag present, one attempt, expected status passed", tone: "pass" },
      { label: "verdict", detail: "manifest signed — re-verify offline against the public key", tone: "pass" },
    ],
    verdict: "PASS",
    moral: (
      <>
        Retries do not launder a failure. The first attempt must pass, the tag must be exact, and the
        bundle is checksummed and signed so a reviewer can re-check it without trusting the runner.
      </>
    ),
  },
]

const FRAME_MS = 1150

function reducer(state: { scenario: number; step: number }, action: "tick" | "reset") {
  if (action === "reset") return { scenario: 0, step: 0 }
  const scenario = SCENARIOS[state.scenario]
  if (state.step < scenario.steps.length) return { ...state, step: state.step + 1 }
  return { scenario: (state.scenario + 1) % SCENARIOS.length, step: 0 }
}

function usePrefersReducedMotion() {
  const ref = useRef(false)
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    ref.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  }
  return ref.current
}

export default function ProofChain(): ReactNode {
  const reduced = usePrefersReducedMotion()
  const [state, dispatch] = useReducer(reducer, reduced ? { scenario: 1, step: 4 } : { scenario: 0, step: 0 })

  useEffect(() => {
    if (reduced) return undefined
    const timer = window.setInterval(() => dispatch("tick"), FRAME_MS)
    return () => window.clearInterval(timer)
  }, [reduced])

  const scenario = SCENARIOS[state.scenario]
  const settled = state.step >= scenario.steps.length

  return (
    <div className={styles.wrap}>
      <div className={clsxTone(styles.panel, settled ? scenario.verdict.toLowerCase() : "")}>
        <div className={styles.bar}>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <strong>dogfood run --policy .dogfood/dogfood.policy.yaml</strong>
        </div>

        <div className={styles.body}>
          <p className={styles.claim}>
            <span className={styles.prompt}>$</span> {scenario.command}
            <em className={styles.claimText}>{scenario.claim}</em>
          </p>

          <ol className={styles.steps}>
            {scenario.steps.map((step, index) => {
              const revealed = index < state.step
              return (
                <li
                  key={step.label}
                  className={clsxTone(styles.step, revealed ? step.tone : "")}
                  data-revealed={revealed ? "true" : "false"}
                >
                  <span className={styles.stepLabel}>{step.label}</span>
                  <span className={styles.stepDetail}>{step.detail}</span>
                </li>
              )
            })}
          </ol>

          <div className={styles.verdictRow} data-settled={settled ? "true" : "false"}>
            <span className={clsxTone(styles.verdictChip, scenario.verdict.toLowerCase())}>
              {scenario.verdict}
            </span>
            <span className={styles.exit}>exit {scenario.verdict === "PASS" ? 0 : 1}</span>
          </div>
        </div>
      </div>

      <p className={styles.moral} key={scenario.id}>
        {scenario.moral}
      </p>

      <div className={styles.dots} role="tablist" aria-label="Example runs">
        {SCENARIOS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={index === state.scenario}
            aria-label={`Show the ${item.id} run`}
            className={index === state.scenario ? styles.dotActive : styles.dot}
            onClick={() => dispatch("reset")}
          />
        ))}
      </div>
    </div>
  )
}

function clsxTone(base: string, tone: string) {
  return tone ? `${base} ${styles[tone] ?? ""}`.trim() : base
}
