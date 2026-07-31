import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export class ContractInputError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ContractInputError";
  }
}

export function findContractPath(cwd, explicit) {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new ContractInputError(`Contract not found: ${path}`);
    return path;
  }

  const candidates = [
    ".dogfood/dogfood.contract.yaml",
    ".dogfood/dogfood.contract.yml",
    ".dogfood/dogfood.contract.json",
    "dogfood.contract.yaml",
    "dogfood.contract.yml",
    "dogfood.contract.json",
  ];
  for (const candidate of candidates) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) return path;
  }
  throw new ContractInputError(
    `No dogfood contract found under ${cwd}. Expected .dogfood/dogfood.contract.yaml (or pass --contract).`,
  );
}

export function loadContractDocument(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ContractInputError(`Could not read contract ${filePath}: ${error.message}`, {
      cause: error,
    });
  }

  try {
    const extension = extname(filePath).toLowerCase();
    const contract = extension === ".json" ? JSON.parse(raw) : parseYaml(raw);
    return { contract, raw };
  } catch (error) {
    throw new ContractInputError(`Could not parse contract ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
}

export function loadContract(filePath) {
  return loadContractDocument(filePath).contract;
}

export { parseYaml };
