/* eslint-disable unicorn/import-style, vitest/prefer-importing-vitest-globals */
import { describe, expect, test } from "bun:test";

import { QUERY_LIMITS } from "../src/lib/query/contract.ts";
import type { Tables } from "../src/lib/query/contract.ts";
import { SqlError } from "../src/lib/query/sql/error.ts";
import { executeSql } from "../src/lib/query/sql/execute.ts";
import {
  QuerySyntaxError,
  toJavaScript,
} from "../src/lib/query/strip-types.ts";

const tables: Tables = {
  daily: [
    { cost: 1.25, date: "2026-09-21", tokens: 100 },
    { cost: 2.5, date: "2026-09-22", tokens: 300 },
    { cost: 0.75, date: "2026-09-28", tokens: 50 },
  ],
  sessions: [
    {
      agent: "claude",
      cost: 1.5,
      model: "claude-sonnet-4-5",
      project: "web",
      title: "Fix bug",
      tokens: 100,
    },
    {
      agent: "codex",
      cost: 0.5,
      model: "gpt-5",
      project: "web",
      title: "Add tests",
      tokens: 300,
    },
    {
      agent: "claude",
      cost: 2,
      model: "claude-opus-4-5",
      project: "api",
      title: null,
      tokens: 50,
    },
    {
      agent: "pi",
      cost: 0,
      model: "qwen",
      project: "infra",
      title: "Deploy",
      tokens: 10,
    },
  ],
};

const run = (sql: string) => executeSql(sql, tables);

interface Failure {
  line: number;
  message: string;
}

const failure = (sql: string): Failure => {
  try {
    run(sql);
  } catch (error) {
    if (error instanceof SqlError) {
      return { line: error.line, message: error.message };
    }
    throw error;
  }
  throw new Error("expected the query to fail");
};
const rows = (sql: string) => run(sql).rows;

describe("TokTracker SQL: selecting", () => {
  test("selects columns, aliases and expressions", () => {
    const result = run(
      "SELECT agent, cost * 2 AS double, tokens / 4 FROM sessions LIMIT 2"
    );
    expect(result.columns).toEqual(["agent", "double", "tokens / 4"]);
    expect(result.rows).toEqual([
      ["claude", 3, 25],
      ["codex", 1, 75],
    ]);
  });

  test("selects every column with *", () => {
    expect(run("select * from daily limit 1").columns).toEqual([
      "cost",
      "date",
      "tokens",
    ]);
  });

  test("filters with WHERE, LIKE, IN, BETWEEN and IS NULL", () => {
    expect(
      rows("SELECT title FROM sessions WHERE agent = 'claude' AND cost > 1.6")
    ).toEqual([[null]]);
    expect(
      rows(
        "SELECT agent FROM sessions WHERE model LIKE 'claude%' ORDER BY cost"
      )
    ).toEqual([["claude"], ["claude"]]);
    expect(
      rows("SELECT agent FROM sessions WHERE agent NOT IN ('claude', 'codex')")
    ).toEqual([["pi"]]);
    expect(
      rows(
        "SELECT tokens FROM sessions WHERE tokens BETWEEN 50 AND 100 ORDER BY 1"
      )
    ).toEqual([[50], [100]]);
    expect(rows("SELECT agent FROM sessions WHERE title IS NULL")).toEqual([
      ["claude"],
    ]);
  });

  test("works without FROM", () => {
    expect(rows("SELECT 1 + 2 AS three, 'a' || 'b', ROUND(2.345, 2)")).toEqual([
      [3, "ab", 2.35],
    ]);
  });

  test("accepts comments, quoted identifiers and a trailing semicolon", () => {
    expect(
      rows(
        '-- note\nSELECT "agent" /* inline */ FROM [sessions] WHERE `cost` > 1.9;'
      )
    ).toEqual([["claude"]]);
  });
});

describe("TokTracker SQL: aggregating", () => {
  test("groups, aggregates and orders", () => {
    expect(
      rows(`SELECT agent, COUNT(*) AS sessions, ROUND(SUM(cost), 2) AS cost, AVG(tokens)
            FROM sessions GROUP BY agent ORDER BY cost DESC`)
    ).toEqual([
      ["claude", 2, 3.5, 75],
      ["codex", 1, 0.5, 300],
      ["pi", 1, 0, 10],
    ]);
  });

  test("filters groups with HAVING (including aliases)", () => {
    expect(
      rows(
        "SELECT project, SUM(cost) AS spend FROM sessions GROUP BY project HAVING spend >= 2 ORDER BY project"
      )
    ).toEqual([
      ["api", 2],
      ["web", 2],
    ]);
  });

  test("aggregates the whole table without GROUP BY, even when empty", () => {
    expect(
      rows("SELECT COUNT(*), MAX(tokens), MIN(cost) FROM sessions")
    ).toEqual([[4, 300, 0]]);
    expect(
      rows(
        "SELECT COUNT(*), SUM(cost), TOTAL(cost) FROM sessions WHERE cost > 100"
      )
    ).toEqual([[0, null, 0]]);
  });

  test("supports DISTINCT, COUNT(DISTINCT) and GROUP_CONCAT", () => {
    expect(
      rows("SELECT DISTINCT project FROM sessions ORDER BY project")
    ).toEqual([["api"], ["infra"], ["web"]]);
    expect(rows("SELECT COUNT(DISTINCT agent) FROM sessions")).toEqual([[3]]);
    expect(
      rows(
        "SELECT GROUP_CONCAT(agent, '+') FROM sessions WHERE project = 'web'"
      )
    ).toEqual([["claude+codex"]]);
  });

  test("buckets dates", () => {
    expect(
      rows(
        "SELECT WEEK(date) AS week, SUM(tokens) FROM daily GROUP BY week ORDER BY week"
      )
    ).toEqual([
      ["2026-09-21", 400],
      ["2026-09-28", 50],
    ]);
    expect(
      rows(
        "SELECT STRFTIME('%Y-%m/%d', date), MONTH(date), DATE('2026-09-21T10:00:00Z') FROM daily LIMIT 1"
      )
    ).toEqual([["2026-09/21", "2026-09", "2026-09-21"]]);
  });
});

describe("TokTracker SQL: expressions", () => {
  test("evaluates CASE, CAST and scalar functions", () => {
    expect(
      rows(`SELECT CASE WHEN cost >= 1 THEN 'big' ELSE 'small' END, CAST(cost AS INTEGER),
                   UPPER(agent), SUBSTR(model, 1, 6), COALESCE(title, 'untitled'), IIF(tokens > 60, 1, 0)
            FROM sessions WHERE project = 'api'`)
    ).toEqual([["big", 2, "CLAUDE", "claude", "untitled", 0]]);
  });

  test("follows NULL logic and divides safely", () => {
    expect(
      rows(
        "SELECT NULL = NULL, NULL IS NULL, 1 / 0, 5 / 2, NULL OR 1, NULL AND 0"
      )
    ).toEqual([[null, 1, null, 2.5, 1, 0]]);
  });

  test("orders with NULLs, ordinals and OFFSET", () => {
    expect(rows("SELECT title FROM sessions ORDER BY title")).toEqual([
      [null],
      ["Add tests"],
      ["Deploy"],
      ["Fix bug"],
    ]);
    expect(
      rows(
        "SELECT title FROM sessions ORDER BY title DESC NULLS LAST LIMIT 2 OFFSET 2"
      )
    ).toEqual([["Add tests"], [null]]);
    expect(
      rows("SELECT agent, tokens FROM sessions ORDER BY 2 DESC LIMIT 1")
    ).toEqual([["codex", 300]]);
  });
});

describe("TokTracker SQL: errors", () => {
  test("names unknown tables, columns and functions with their line", () => {
    expect(failure("SELECT *\nFROM nope")).toEqual({
      line: 2,
      message: "No such table: nope. Tables here: daily, sessions.",
    });
    expect(failure("SELECT agent\nFROM sessions\nWHERE nme = 1").line).toBe(3);
    expect(
      failure("SELECT agent\nFROM sessions\nWHERE nme = 1").message
    ).toContain("No such column: nme");
    expect(failure("SELECT LOAD_EXTENSION('x')").message).toContain(
      "Unknown function LOAD_EXTENSION"
    );
  });

  test("rejects anything but one SELECT over one table", () => {
    for (const sql of [
      "DROP TABLE sessions",
      "SELECT * FROM sessions JOIN daily",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SELECT 1; SELECT 2",
      "ATTACH DATABASE '/etc/passwd' AS host",
      "SELECT * FROM sessions UNION SELECT * FROM daily",
      "SELECT (SELECT 1)",
    ]) {
      expect(() => run(sql)).toThrow();
    }
    expect(failure("SELECT * FROM sessions LEFT JOIN daily").message).toContain(
      "LEFT is not supported"
    );
  });

  test("explains syntax mistakes", () => {
    expect(failure("SELECT agent,\nFROM sessions").message).toContain(
      "Expected a value"
    );
    expect(failure("SELECT 'open").message).toContain("Unterminated");
    expect(
      failure("SELECT SUM(cost) FROM sessions WHERE SUM(cost) > 1").message
    ).toContain("aggregate");
  });

  test("bounds nesting depth", () => {
    const deep = `SELECT ${"(".repeat(200)}1${")".repeat(200)}`;
    expect(failure(deep).message).toContain("nested too deeply");
  });

  test("caps output rows", () => {
    const many: Tables = {
      daily: Array.from({ length: QUERY_LIMITS.rows + 10 }, (_, index) => ({
        cost: index,
        date: "2026-01-01",
        tokens: 1,
      })),
    };
    const result = executeSql("SELECT cost FROM daily", many);
    expect(result.rows).toHaveLength(QUERY_LIMITS.rows);
    expect(result.truncated).toBe(true);
  });
});

const syntaxErrorLine = (code: string): number | undefined => {
  try {
    toJavaScript(code, true);
  } catch (error) {
    return error instanceof QuerySyntaxError ? error.line : undefined;
  }
  return undefined;
};

describe("toJavaScript", () => {
  test("strips TypeScript types and keeps the line layout", () => {
    const source = [
      "interface Row { name: string }",
      "const rows: Row[] = data.agents as Row[];",
      "const best = rows.find((row) => row.name.length > 1)!;",
      "function pick<T>(items: T[], limit?: number): T[] { return items.slice(0, limit); }",
      "return pick<Row>(rows, 2) satisfies Row[];",
    ].join("\n");
    const output = toJavaScript(source, true);
    expect(output.split("\n")).toHaveLength(5);
    expect(output).not.toContain("interface");
    expect(output).not.toMatch(/:\s*Row|as Row|satisfies|<T>|limit\?/u);
    // Re-parsing the output as JavaScript proves no type syntax is left.
    expect(() => toJavaScript(output, false)).not.toThrow();
  });

  test("leaves JavaScript alone and reports syntax errors with lines", () => {
    const javascript = "const a = x?.y ?? (b < c && c > d);\nreturn [a];";
    expect(toJavaScript(javascript, false)).toBe(javascript);
    expect(() => toJavaScript("const a = 1;\nconst b = ;", false)).toThrow(
      /Unexpected syntax/u
    );
    expect(() => toJavaScript("const a = 1;\nconst b = ;", true)).toThrow(
      QuerySyntaxError
    );
    expect(syntaxErrorLine("const a = 1;\nconst b = ;")).toBe(2);
  });

  test("rejects TypeScript that needs a compiler", () => {
    expect(() => toJavaScript("enum Colour { Red }", true)).toThrow(
      /Enums are not supported/u
    );
    expect(() =>
      toJavaScript("namespace N { export const a = 1; }", true)
    ).toThrow(/Namespaces/u);
  });
});
