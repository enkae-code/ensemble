function getAliasTarget(config, key) {
  const aliases = config.alias ?? {};
  return aliases[key] ?? key;
}

function flagTakesValue(config, key) {
  const stringFlags = new Set(config.string ?? []);
  return stringFlags.has(key);
}

/** Split a shell-like raw argument string into argv tokens. */
export function splitRawArgumentString(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const character of raw) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaped) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in raw argument string.`);
  }

  if (current !== "") {
    tokens.push(current);
  }

  return tokens;
}

/** Parse argv into flags, positionals, and passthrough arguments. */
export function parseArgs(argv, config = {}) {
  const input = argv.length === 1 ? splitRawArgumentString(argv[0]) : [...argv];
  const parsed = { _: [], "--": [] };
  const booleanFlags = new Set(config.boolean ?? []);
  const defaults = config.default ?? {};

  for (const [key, value] of Object.entries(defaults)) {
    parsed[getAliasTarget(config, key)] = value;
  }

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];

    if (token === "--") {
      parsed["--"] = input.slice(index + 1);
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      parsed._.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, rawValue] = token.slice(2).split("=", 2);
      const key = getAliasTarget(config, rawKey);
      if (rawValue !== undefined) {
        parsed[key] = rawValue;
        continue;
      }

      if (flagTakesValue(config, key)) {
        index += 1;
        if (index >= input.length) {
          throw new Error(`Missing value for --${rawKey}.`);
        }
        parsed[key] = input[index];
        continue;
      }

      parsed[key] = booleanFlags.has(key) ? true : true;
      continue;
    }

    const cluster = token.slice(1);
    if (cluster.length > 1 && !flagTakesValue(config, getAliasTarget(config, cluster[0]))) {
      for (const shortFlag of cluster) {
        const key = getAliasTarget(config, shortFlag);
        parsed[key] = true;
      }
      continue;
    }

    const shortFlag = cluster[0];
    const key = getAliasTarget(config, shortFlag);
    if (flagTakesValue(config, key)) {
      const attached = cluster.slice(1);
      if (attached) {
        parsed[key] = attached;
      } else {
        index += 1;
        if (index >= input.length) {
          throw new Error(`Missing value for -${shortFlag}.`);
        }
        parsed[key] = input[index];
      }
      continue;
    }

    parsed[key] = true;
  }

  return parsed;
}
