/** One Ajv error formatter; the contract and policy validators differ only in the root label. */
export function formatAjvError(error, root = "document") {
  const path = error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : root;
  if (error.keyword === "additionalProperties") return `${path}: unknown field "${error.params.additionalProperty}"`;
  if (error.keyword === "required") return `${path}: missing required field "${error.params.missingProperty}"`;
  if (error.keyword === "const") return `${path}: must be ${JSON.stringify(error.params.allowedValue)}`;
  if (error.keyword === "enum") return `${path}: must be one of ${error.params.allowedValues.map(JSON.stringify).join(", ")}`;
  return `${path}: ${error.message}`;
}
