import { mergeScriptEntries } from "./dispatch.js";

const FLAG_ORDER = [
  "requires-body",
  "binary-body-mode",
  "engine",
  "ability",
  "max-size",
];

function stableUnion(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const value of list) {
      if (!seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
  }
  return result;
}

function rawDefault(argument) {
  if (argument.rawDefault !== undefined) return argument.rawDefault;
  return argument.quoted ? JSON.stringify(argument.default) : String(argument.default);
}

function formatArguments(module, prefix) {
  return module.arguments.map((argument) => `${prefix}.${argument.key}:${rawDefault(argument)}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixArgumentsDesc(module, prefix) {
  let description = module.argumentsDesc || "";
  for (const { key } of module.arguments) {
    const heading = new RegExp(`(^|\\\\n\\\\n)${escapeRegex(key)}(?=:)`, "g");
    description = description.replace(heading, `$1${prefix}.${key}`);
  }
  return description;
}

function formatFlags(flags) {
  const keys = [
    ...FLAG_ORDER.filter((key) => Object.hasOwn(flags, key)),
    ...Object.keys(flags).filter((key) => !FLAG_ORDER.includes(key)),
  ];
  return keys.map((key) => (flags[key] === true ? key : `${key}=${flags[key]}`));
}

function validateHost(host) {
  if (typeof host !== "string" || !host.trim() || /[/?#]/.test(host)) {
    throw new Error(`Invalid module host: ${host}`);
  }
  const url = new URL(`https://${host}`);
  if (url.host !== host) throw new Error(`Invalid module host: ${host}`);
  return url.host;
}

export function generateSgmodule({ adblock, global: globalModule, host }) {
  const safeHost = validateHost(host);
  const entries = mergeScriptEntries(adblock.scripts, globalModule.scripts);
  const argumentDefinitions = [
    ...formatArguments(adblock, "ADBlock"),
    ...formatArguments(globalModule, "Global"),
  ];
  const allArgumentKeys = [
    ...adblock.arguments.map(({ key }) => `ADBlock.${key}`),
    ...globalModule.arguments.map(({ key }) => `Global.${key}`),
  ];
  const scriptArgument = allArgumentKeys
    .map((key) => `${key}="{{{${key}}}}"`)
    .join("&");
  const argumentsDesc = [
    prefixArgumentsDesc(adblock, "ADBlock"),
    prefixArgumentsDesc(globalModule, "Global"),
  ]
    .filter(Boolean)
    .join("\\n\\n");

  const lines = [
    "#!name = Biliverse ADBlock & Global 2in1",
    `#!desc = Biliverse ADBlock ${adblock.version} & Global ${globalModule.version} 2in1；构建期合并，运行时只执行一个脚本`,
    `#!author = ${stableUnion(adblock.author ? [adblock.author] : [], globalModule.author ? [globalModule.author] : []).join(",") || "Biliverse, BiliMerge"}`,
    `#!homepage = ${adblock.homepage || globalModule.homepage || "https://github.com/Biliverse"}`,
    "#!category = 🪐 Biliverse",
    `#!date = ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    `#!version = ${adblock.version}+${globalModule.version}`,
    `#!arguments = ${argumentDefinitions.join(",")}`,
    `#!arguments-desc = ${argumentsDesc}`,
    "",
  ];

  const appendSection = (name, sectionLines) => {
    if (!sectionLines.length) return;
    lines.push(`[${name}]`, ...sectionLines, "");
  };

  appendSection("Map Local", [...adblock.mapLocal, ...globalModule.mapLocal]);
  appendSection("Body Rewrite", [...adblock.bodyRewrite, ...globalModule.bodyRewrite]);

  const scriptLines = entries.map((entry, index) => {
    const kind = entry.type === "http-response" ? "response" : "request";
    const suffix = entry.sources.length > 1 ? " (A+B)" : "";
    const fields = [
      `type=${entry.type}`,
      `pattern=${entry.pattern}`,
      ...formatFlags(entry.flags),
      `script-path=https://${safeHost}/merged-${kind}.js`,
      `argument=${scriptArgument}`,
    ];
    return `📺 BiliMerge.${kind}.${String(index + 1).padStart(2, "0")}${suffix} = ${fields.join(", ")}`;
  });
  appendSection("Script", scriptLines);

  const hostnames = stableUnion(adblock.mitm.hostnames, globalModule.mitm.hostnames);
  appendSection("MITM", [
    `hostname = %APPEND% ${hostnames.join(", ")}`,
    "h2 = true",
  ]);

  return `${lines.join("\n").trimEnd()}\n`;
}

export const _internals = { stableUnion, prefixArgumentsDesc, formatFlags, validateHost };
