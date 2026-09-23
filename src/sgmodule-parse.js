const SECTION_RE = /^\s*\[([^\]]+)]\s*$/;

function splitDelimited(input, delimiter = ",") {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === delimiter) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function splitFirst(input, delimiter) {
  const index = input.indexOf(delimiter);
  if (index < 0) return [input.trim(), ""];
  return [input.slice(0, index).trim(), input.slice(index + delimiter.length).trim()];
}

function parseArguments(raw = "") {
  if (!raw.trim()) return [];
  return splitDelimited(raw).map((entry) => {
    const [key, rawDefault] = splitFirst(entry, ":");
    if (!key || rawDefault === "") {
      throw new Error(`Invalid #!arguments entry: ${entry}`);
    }
    const quoted =
      rawDefault.length >= 2 &&
      ((rawDefault.startsWith('"') && rawDefault.endsWith('"')) ||
        (rawDefault.startsWith("'") && rawDefault.endsWith("'")));
    return {
      key,
      default: quoted ? rawDefault.slice(1, -1) : rawDefault,
      quoted,
      rawDefault,
    };
  });
}

function splitScriptFields(input) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "," && /^\s*[A-Za-z][\w-]*\s*=/.test(input.slice(i + 1))) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function parseScript(line) {
  const [name, value] = splitFirst(line, "=");
  if (!name || !value) throw new Error(`Invalid script line: ${line}`);

  const fields = {};
  const flags = {};
  for (const part of splitScriptFields(value)) {
    const [key, fieldValue] = splitFirst(part, "=");
    if (!key) continue;
    fields[key] = fieldValue || true;
  }

  const type = fields.type;
  const pattern = fields.pattern;
  const scriptPath = fields["script-path"];
  if (!type || !pattern || !scriptPath) {
    throw new Error(`Script is missing type, pattern, or script-path: ${name}`);
  }

  for (const [key, fieldValue] of Object.entries(fields)) {
    if (!["type", "pattern", "script-path", "argument"].includes(key)) {
      flags[key] = fieldValue;
    }
  }

  const argument = typeof fields.argument === "string" ? fields.argument : "";
  const argumentKeys = [];
  const seen = new Set();
  for (const match of argument.matchAll(/\{\{\{([^}]+)}}}/g)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      argumentKeys.push(match[1]);
    }
  }

  return { name, type, pattern, flags, scriptPath, argumentKeys };
}

function contentLines(lines = [], { comments = false } = {}) {
  return lines.filter(
    (line) =>
      line.trim() !== "" &&
      (comments || (!line.trimStart().startsWith("#") && !line.trimStart().startsWith(";"))),
  );
}

export function parseSgmodule(text) {
  if (typeof text !== "string") throw new TypeError("sgmodule text must be a string");

  const metadata = {};
  const sections = new Map();
  let section = null;

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = rawLine.match(SECTION_RE);
    if (match) {
      section = match[1].trim().toLowerCase();
      if (!sections.has(section)) sections.set(section, []);
      continue;
    }

    const metadataMatch = rawLine.match(/^\s*#!([^=]+?)\s*=\s*(.*)$/);
    if (!section && metadataMatch) {
      metadata[metadataMatch[1].trim().toLowerCase()] = metadataMatch[2];
      continue;
    }

    if (section) sections.get(section).push(rawLine);
  }

  const scriptLines = contentLines(sections.get("script"));
  const scripts = scriptLines.map(parseScript);

  const mitmLines = contentLines(sections.get("mitm"));
  let hostnames = [];
  let h2 = false;
  for (const line of mitmLines) {
    const [key, value] = splitFirst(line, "=");
    if (key.toLowerCase() === "hostname") {
      hostnames.push(...value
        .replace(/^%APPEND%\s*/i, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean));
    } else if (key.toLowerCase() === "h2") {
      h2 = value.toLowerCase() === "true";
    }
  }

  if (!metadata.version) throw new Error("sgmodule is missing #!version");
  if (!metadata.name) throw new Error("sgmodule is missing #!name");
  if (scripts.length === 0) throw new Error("sgmodule has no script entries");

  return {
    version: metadata.version.trim().replace(/^v/i, ""),
    name: metadata.name.trim(),
    description: metadata.desc ?? "",
    date: (metadata.date ?? "").trim(),
    author: metadata.author ?? "",
    homepage: metadata.homepage ?? "",
    arguments: parseArguments(metadata.arguments),
    argumentsDesc: metadata["arguments-desc"] ?? "",
    mapLocal: contentLines(sections.get("map local")),
    bodyRewrite: contentLines(sections.get("body rewrite")),
    scripts,
    mitm: { hostnames, h2 },
  };
}

export const _internals = { splitDelimited, splitScriptFields, parseArguments, parseScript };
