import { describeJunitSelector, junitSelectorKey } from "./junit.mjs";

export function scoreAcceptanceCriteria(
  contract,
  commandResults,
  { validateOnly = false, advisoryReceipts = [] } = {},
) {
  const commands = new Map(commandResults.map((result) => [result.name, result]));
  const receiptsByAc = new Map();
  for (const receipt of advisoryReceipts) {
    const values = receiptsByAc.get(receipt.acId) || [];
    values.push(receipt);
    receiptsByAc.set(receipt.acId, values);
  }

  return (contract.acceptanceCriteria || []).map((criterion) => {
    const oracle = criterion.oracle ? contract.oracles?.[criterion.oracle] : null;
    const base = {
      id: criterion.id,
      issue: criterion.issue ?? null,
      class: criterion.class,
      severity: criterion.severity,
      oracle: criterion.oracle ?? null,
      advisoryEvidence: receiptsByAc.get(criterion.id) || [],
    };

    if (criterion.class === "excluded") {
      return { ...base, verdict: "excluded", detail: `excluded: ${criterion.reason}` };
    }

    if (criterion.class === "judgmental") {
      const receipts = base.advisoryEvidence;
      const detail = receipts.length === 0
        ? `advisory oracle ${criterion.oracle}; no advisory receipt supplied`
        : `advisory oracle ${criterion.oracle}; ${receipts.length} receipt(s): ${receipts
            .map((receipt) => receipt.assessment)
            .join(", ")}`;
      return { ...base, verdict: "advisory", detail };
    }

    if (validateOnly) {
      return {
        ...base,
        verdict: "not-run",
        detail: `oracle ${criterion.oracle} is valid and mapped; execution was not requested`,
      };
    }

    if (!oracle) {
      return { ...base, verdict: "fail", detail: "missing oracle (missing oracle = FAIL)" };
    }
    if (oracle.kind === "advisory") {
      return {
        ...base,
        verdict: "fail",
        detail: "deterministic criterion cannot be proven by advisory evidence",
      };
    }

    const command = commands.get(oracle.command);
    if (!command) {
      return {
        ...base,
        verdict: "fail",
        detail: `oracle command "${oracle.command}" was not executed`,
      };
    }
    if (command.status === "infra") {
      return {
        ...base,
        verdict: "blocked",
        detail: `oracle command "${oracle.command}" was blocked by infrastructure trouble`,
      };
    }
    if (command.mutationDetected) {
      return {
        ...base,
        verdict: "fail",
        detail: `oracle command "${oracle.command}" changed tracked repository state`,
      };
    }
    if (command.status !== "pass") {
      // The selector's own detail is the reason only when the selector is what failed. A criterion
      // whose test passed inside a command that failed must not be reported as "passed" beside a
      // fail verdict: a runner that exits non-zero may have written a partial report, and no
      // adapter can tell "one test failed" from "the runner broke" without runner-specific
      // knowledge it deliberately does not have. So it fails closed, and says why.
      const selector = selectorResult(command, oracle);
      if (selector && selector.status !== "pass") {
        return { ...base, verdict: "fail", detail: selector.detail };
      }
      const reason = command.detail || "the command did not pass";
      return {
        ...base,
        verdict: "fail",
        detail: selector
          ? `oracle command "${oracle.command}" did not pass, so its report cannot prove this criterion even though the selector matched: ${reason}`
          : reason,
      };
    }

    if (oracle.kind === "playwright") {
      const tagResult = command.adapter?.tags?.[oracle.tag];
      if (!tagResult || tagResult.status !== "pass") {
        return {
          ...base,
          verdict: "fail",
          detail: tagResult?.detail || `Playwright tag ${oracle.tag} was not evaluated`,
        };
      }
      return {
        ...base,
        verdict: "pass",
        detail: tagResult.detail,
      };
    }

    if (oracle.kind === "junit") {
      const caseResult = command.adapter?.testcases?.[junitSelectorKey(oracle.testcase)];
      if (!caseResult || caseResult.status !== "pass") {
        return {
          ...base,
          verdict: "fail",
          detail: caseResult?.detail || `JUnit testcase ${describeJunitSelector(oracle.testcase)} was not evaluated`,
        };
      }
      return {
        ...base,
        verdict: "pass",
        detail: caseResult.detail,
      };
    }

    return {
      ...base,
      verdict: "pass",
      detail: `complete command ${oracle.command} passed`,
    };
  });
}

export function collectCommandsToRun(contract) {
  const names = new Set();
  for (const gateCommands of Object.values(contract.gates || {})) {
    for (const name of gateCommands || []) names.add(name);
  }
  for (const criterion of contract.acceptanceCriteria || []) {
    if (criterion.class !== "deterministic") continue;
    const oracle = contract.oracles?.[criterion.oracle];
    if (oracle?.command) names.add(oracle.command);
  }
  return [...names];
}

export function expectedPlaywrightTags(contract) {
  const tags = Object.create(null);
  for (const criterion of contract.acceptanceCriteria || []) {
    if (criterion.class !== "deterministic") continue;
    const oracle = contract.oracles?.[criterion.oracle];
    if (oracle?.kind !== "playwright") continue;
    tags[oracle.command] ||= [];
    tags[oracle.command].push(oracle.tag);
  }
  for (const [command, values] of Object.entries(tags)) {
    tags[command] = [...new Set(values)];
  }
  return tags;
}

export function expectedJunitCases(contract) {
  const cases = Object.create(null);
  for (const criterion of contract.acceptanceCriteria || []) {
    if (criterion.class !== "deterministic") continue;
    const oracle = contract.oracles?.[criterion.oracle];
    if (oracle?.kind !== "junit") continue;
    cases[oracle.command] ||= new Map();
    cases[oracle.command].set(junitSelectorKey(oracle.testcase), oracle.testcase);
  }
  for (const [command, selectors] of Object.entries(cases)) {
    cases[command] = [...selectors.values()];
  }
  return cases;
}

function selectorResult(command, oracle) {
  if (oracle.kind === "playwright") return command.adapter?.tags?.[oracle.tag];
  if (oracle.kind === "junit") return command.adapter?.testcases?.[junitSelectorKey(oracle.testcase)];
  return null;
}
