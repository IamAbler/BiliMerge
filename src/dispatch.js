const MAX_SAMPLES = 256;

function combine(left, right) {
  const result = [];
  for (const a of left) {
    for (const b of right) {
      result.push(a + b);
      if (result.length >= MAX_SAMPLES) return result;
    }
  }
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function sampleRegex(source) {
  let index = 0;
  let uncertain = false;

  function expression(stop = null) {
    const alternatives = [];
    let current = [""];
    while (index < source.length) {
      const char = source[index];
      if (char === stop) break;
      if (char === "|") {
        alternatives.push(...current);
        current = [""];
        index += 1;
        continue;
      }
      current = combine(current, quantifiedAtom());
    }
    alternatives.push(...current);
    return unique(alternatives).slice(0, MAX_SAMPLES);
  }

  function quantifiedAtom() {
    let values = atom();
    if (index >= source.length) return values;
    const quantifier = source[index];
    if (quantifier === "?") {
      index += 1;
      values = ["", ...values];
    } else if (quantifier === "*") {
      index += 1;
      values = ["", ...values];
    } else if (quantifier === "+") {
      index += 1;
    } else if (quantifier === "{") {
      const end = source.indexOf("}", index);
      if (end < 0) {
        uncertain = true;
      } else {
        const spec = source.slice(index + 1, end);
        const [minimumRaw, maximumRaw] = spec.split(",");
        const minimum = Number.parseInt(minimumRaw, 10);
        const maximum = maximumRaw === undefined ? minimum : Number.parseInt(maximumRaw, 10);
        if (!Number.isFinite(minimum)) {
          uncertain = true;
        } else {
          let repeated = [""];
          for (let count = 0; count < Math.min(minimum, 4); count += 1) {
            repeated = combine(repeated, values);
          }
          if (minimum > 4 || (Number.isFinite(maximum) && maximum > minimum)) uncertain = true;
          values = repeated;
        }
        index = end + 1;
      }
    }
    return unique(values).slice(0, MAX_SAMPLES);
  }

  function atom() {
    const char = source[index++];
    if (char === "^" || char === "$") return [""];
    if (char === ".") return ["x"];
    if (char === "\\") {
      if (index >= source.length) {
        uncertain = true;
        return [""];
      }
      const escaped = source[index++];
      if (escaped === "d") return ["1"];
      if (escaped === "w") return ["a"];
      if (escaped === "s") return [" "];
      if (/[1-9bkBpP]/.test(escaped)) uncertain = true;
      return [escaped];
    }
    if (char === "[") {
      let negate = false;
      if (source[index] === "^") {
        negate = true;
        index += 1;
      }
      let picked = "";
      while (index < source.length && source[index] !== "]") {
        let candidate = source[index++];
        if (candidate === "\\" && index < source.length) candidate = source[index++];
        if (!picked && candidate !== "-") picked = candidate;
      }
      if (source[index] === "]") index += 1;
      if (negate) uncertain = true;
      return [picked || "a"];
    }
    if (char === "(") {
      if (source[index] === "?") {
        if (source.slice(index, index + 2) === "?:") index += 2;
        else {
          uncertain = true;
          const close = source.indexOf(")", index);
          index = close < 0 ? source.length : close + 1;
          return [""];
        }
      }
      const values = expression(")");
      if (source[index] === ")") index += 1;
      else uncertain = true;
      return values;
    }
    if (char === ")") {
      uncertain = true;
      return [""];
    }
    return [char];
  }

  const samples = expression();
  return { samples: unique(samples).slice(0, MAX_SAMPLES), uncertain };
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function analyzeIntersection(a, b) {
  if (a === b) return { intersects: true, patterns: [a], uncertain: false };
  const regexA = safeRegex(a);
  const regexB = safeRegex(b);
  const generatedA = sampleRegex(a);
  const generatedB = sampleRegex(b);
  if (!regexA || !regexB || generatedA.uncertain || generatedB.uncertain) {
    return { intersects: true, patterns: unique([a, b]), uncertain: true };
  }

  const aHitsB = generatedA.samples.filter((sample) => regexB.test(sample));
  const bHitsA = generatedB.samples.filter((sample) => regexA.test(sample));
  if (aHitsB.length === 0 && bHitsA.length === 0) {
    return { intersects: false, patterns: [], uncertain: false };
  }

  const aSubsetB = generatedA.samples.length > 0 && aHitsB.length === generatedA.samples.length;
  const bSubsetA = generatedB.samples.length > 0 && bHitsA.length === generatedB.samples.length;
  if (aSubsetB && !bSubsetA) return { intersects: true, patterns: [a], uncertain: false };
  if (bSubsetA && !aSubsetB) return { intersects: true, patterns: [b], uncertain: false };
  if (aSubsetB && bSubsetA) return { intersects: true, patterns: [a], uncertain: false };
  return { intersects: true, patterns: unique([a, b]), uncertain: true };
}

export function mergeFlags(a = {}, b = {}) {
  const merged = { ...a, ...b };
  if (a["max-size"] !== undefined || b["max-size"] !== undefined) {
    const values = [a["max-size"], b["max-size"]]
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite);
    if (values.length) merged["max-size"] = String(Math.max(...values));
  }
  return merged;
}

export function buildDispatch(aScripts, bScripts) {
  const result = {};
  for (const type of ["http-request", "http-response"]) {
    const aPatterns = unique(aScripts.filter((script) => script.type === type).map((script) => script.pattern));
    const bPatterns = unique(bScripts.filter((script) => script.type === type).map((script) => script.pattern));
    const both = [];
    const uncertain = [];

    for (const a of aPatterns) {
      for (const b of bPatterns) {
        const analysis = analyzeIntersection(a, b);
        if (analysis.intersects) both.push(...analysis.patterns);
        if (analysis.uncertain) uncertain.push({ a, b });
      }
    }

    result[type] = {
      aOnly: aPatterns,
      bOnly: bPatterns,
      both: unique(both),
      uncertain,
    };
  }
  return result;
}

function patternContains(container, child) {
  const regex = safeRegex(container);
  const generated = sampleRegex(child);
  return Boolean(
    regex &&
      !generated.uncertain &&
      generated.samples.length > 0 &&
      generated.samples.every((sample) => regex.test(sample)),
  );
}

function unionPattern(patterns) {
  const candidates = unique(patterns);
  const containing = candidates.find((candidate) =>
    candidates.every((pattern) => pattern === candidate || patternContains(candidate, pattern)),
  );
  if (containing) return containing;
  return candidates.map((pattern) => `(?:${pattern})`).join("|");
}

export function mergeScriptEntries(aScripts, bScripts) {
  const entries = [
    ...aScripts.map((script) => ({ ...script, source: "A" })),
    ...bScripts.map((script) => ({ ...script, source: "B" })),
  ];
  const parent = entries.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (left, right) => {
    const a = root(left);
    const b = root(right);
    if (a !== b) parent[b] = a;
  };

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].type !== entries[j].type) continue;
      if (entries[i].source === entries[j].source) continue;
      if (analyzeIntersection(entries[i].pattern, entries[j].pattern).intersects) join(i, j);
    }
  }

  const components = new Map();
  entries.forEach((entry, index) => {
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(entry);
  });

  return [...components.values()].map((component) => {
    const first = component[0];
    const flags = component.reduce((merged, entry) => mergeFlags(merged, entry.flags), {});
    return {
      ...first,
      pattern: unionPattern(component.map(({ pattern }) => pattern)),
      flags,
      sources: unique(component.map(({ source }) => source)),
      sourcePatterns: component.map(({ source, pattern }) => ({ source, pattern })),
    };
  });
}

export const _internals = { sampleRegex, analyzeIntersection, patternContains, unionPattern };
