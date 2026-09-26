import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

// Oxlint 1.80 (required by @shadcn/lint) removed `react/react-compiler`,
// which this Ultracite preset still enables; drop it until Ultracite catches up.
const { "react/react-compiler": _removedRule, ...reactRules } =
  react.rules ?? {};

export default defineConfig({
  extends: [core, { ...react, rules: reactRules }, vitest],
  ignorePatterns: [...core.ignorePatterns, "tools/oxlint/anti-slop/**"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    // Design-system rules for the dashboard. Components and the Tailwind
    // theme are discovered from apps/dashboard/components.json; no shadcn/*
    // rules are enabled yet — add them under `rules` below.
    "@shadcn/lint",
  ],
  overrides: [
    {
      files: ["packages/token-calc/src/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
    },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
