export const REQUIRED_CLI_ADAPTER_METHODS = [
  "buildArgv",
  "spawn",
  "parseOutput",
  "detectAuth",
];

function validateAdapterMethod(adapter, name) {
  if (typeof adapter?.[name] !== "function") {
    throw new Error(`CLI adapter is missing ${name}().`);
  }
}

/** Assert that an object satisfies the arm adapter contract. */
export function assertCliAdapter(adapter) {
  for (const method of REQUIRED_CLI_ADAPTER_METHODS) {
    validateAdapterMethod(adapter, method);
  }
  return adapter;
}

/** Freeze and return a validated CLI adapter implementation. */
export function createCliAdapter(adapter) {
  return Object.freeze(assertCliAdapter({ ...adapter }));
}
