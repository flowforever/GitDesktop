import { describe, expect, it, vi } from "vitest";
import { resolvePrImport } from "@/features/pulls/pr-import-resolution";

const SOURCE = "src/pages/view.tsx";

function snapshot(files: string[], texts: Record<string, string> = {}) {
  const paths = new Set([SOURCE, ...files, ...Object.keys(texts)]);
  const readText = vi.fn(async (path: string) => {
    if (!paths.has(path)) throw new Error(`Outside snapshot: ${path}`);
    return texts[path] ?? null;
  });
  const resolve = (specifier: string, sourcePath = SOURCE) =>
    resolvePrImport({ sourcePath, specifier, paths, readText });
  return { paths, readText, resolve };
}

describe("MR snapshot import resolution", () => {
  it.each([
    ["../utils", "src/utils.ts"],
    ["./Button", "src/pages/Button.tsx"],
    ["./Card.vue", "src/pages/Card.vue"],
    ["./settings.json", "src/pages/settings.json"],
    ["./theme", "src/pages/theme.scss"],
    ["../components", "src/components/index.ts"],
    ["./styles", "src/pages/styles/index.css"],
    ["/shared/constants", "shared/constants.js"],
    ["../utils.js", "src/utils.ts"],
    ["../utils.mjs", "src/utils.mts"],
    ["../utils.cjs", "src/utils.cts"],
  ])("resolves %s against exact snapshot paths", async (specifier, target) => {
    const { resolve, readText } = snapshot([target]);
    expect(await resolve(specifier)).toBe(target);
    expect(readText).not.toHaveBeenCalled();
  });

  it("prefers an exact filename over substitutes, and files over directory indexes", async () => {
    const { resolve } = snapshot([
      "src/utils.js",
      "src/utils.ts",
      "src/utils/index.ts",
      "src/pages/Button.ts",
      "src/pages/Button/index.ts",
      "index.ts",
    ]);
    expect(await resolve("../utils.js")).toBe("src/utils.js");
    expect(await resolve("./Button")).toBe("src/pages/Button.ts");
    expect(await resolve("../../")).toBe("index.ts");
  });

  it("uses nearest JSONC config, exact aliases, wildcard specificity, and target order", async () => {
    const { resolve } = snapshot(
      [
        "src/exact.ts",
        "src/specific/button.ts",
        "src/fallback/button.ts",
        "src/generic/ui/button.ts",
        "root/wrong.ts",
        "src/a,}.ts",
      ],
      {
        "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["root/*"]}}}',
        "src/tsconfig.json": `{
        // Ignore this comment without damaging quoted characters.
        "note": "https://example.test/a,} /* still a string */",
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@exact": ["exact.ts"],
            "@/*": ["generic/*"],
            "@/ui/*": ["missing/*", "specific/*", "fallback/*",],
            "@punctuation": ["a,}.ts"],
          },
        },
      }`,
      },
    );
    expect(await resolve("@exact")).toBe("src/exact.ts");
    expect(await resolve("@/ui/button")).toBe("src/specific/button.ts");
    expect(await resolve("@punctuation")).toBe("src/a,}.ts");
  });

  it("inherits local configs using their own directories and supports jsconfig/baseUrl", async () => {
    const { resolve, readText } = snapshot(
      ["shared/lib/tool.ts", "src/local.ts"],
      {
        "src/jsconfig.json":
          '{"extends":"../config/base","compilerOptions":{"paths":{"@local":["local"]}}}',
        "config/base.json":
          '{"compilerOptions":{"baseUrl":"../shared","paths":{"@/*":["lib/*"]}}}',
      },
    );
    expect(await resolve("lib/tool")).toBe("shared/lib/tool.ts");
    expect(readText.mock.calls.every(([path]) => path.endsWith(".json"))).toBe(
      true,
    );
    const inherited = snapshot(["shared/lib/tool.ts"], {
      "src/jsconfig.json": '{"extends":"../config/base.json"}',
      "config/base.json":
        '{"compilerOptions":{"baseUrl":"../shared","paths":{"@/*":["lib/*"]}}}',
    });
    expect(await inherited.resolve("@/tool")).toBe("shared/lib/tool.ts");
  });

  it("falls back to tsconfig.app.json without leaving the nearest project", async () => {
    const { resolve } = snapshot(["src/app/tool.ts", "root/wrong.ts"], {
      "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["root/*"]}}}',
      "src/tsconfig.json":
        '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
      "src/tsconfig.app.json":
        '{"compilerOptions":{"paths":{"@/*":["app/*"]}}}',
    });
    expect(await resolve("@/tool")).toBe("src/app/tool.ts");
  });

  it("resolves verified workspace package source, exports, and extensionless subpaths", async () => {
    const { resolve } = snapshot(
      [
        "packages/ui/src/index.ts",
        "packages/ui/src/button.tsx",
        "packages/tools/helpers/index.ts",
        "packages/ui/button.ts",
      ],
      {
        "package.json": '{"workspaces":["packages/*"]}',
        "packages/ui/package.json": JSON.stringify({
          name: "@acme/ui",
          source: "src/index.ts",
          module: "dist/index.js",
          exports: {
            ".": "./dist/index.js",
            "./button": { import: "./src/button.tsx" },
          },
        }),
        "packages/tools/package.json": '{"name":"tools"}',
      },
    );
    expect(await resolve("@acme/ui")).toBe("packages/ui/src/index.ts");
    expect(await resolve("@acme/ui/button")).toBe("packages/ui/src/button.tsx");
    expect(await resolve("tools/helpers")).toBe(
      "packages/tools/helpers/index.ts",
    );
    expect(await resolve("@acme/ui/private")).toBeNull();
  });

  it("supports conditional and wildcard exports and declared module/main fallback", async () => {
    const { resolve } = snapshot(
      [
        "packages/ui/src/card.vue",
        "packages/module/entry.mts",
        "packages/main/entry.cjs",
      ],
      {
        "packages/ui/package.json":
          '{"name":"ui","exports":{"./*":{"types":"./missing/*.d.ts","import":"./src/*.vue"}}}',
        "packages/module/package.json":
          '{"name":"module-pkg","module":"entry.mjs"}',
        "packages/main/package.json": '{"name":"main-pkg","main":"entry.cjs"}',
      },
    );
    expect(await resolve("ui/card")).toBe("packages/ui/src/card.vue");
    expect(await resolve("module-pkg")).toBe("packages/module/entry.mts");
    expect(await resolve("main-pkg")).toBe("packages/main/entry.cjs");
  });

  it("prefers configured aliases/baseUrl over a matching workspace package", async () => {
    const { resolve } = snapshot(
      ["src/local.ts", "src/from-base.ts", "packages/local/index.ts"],
      {
        "tsconfig.json":
          '{"compilerOptions":{"baseUrl":"src","paths":{"local":["local.ts"]}}}',
        "packages/local/package.json": '{"name":"local","source":"index.ts"}',
      },
    );
    expect(await resolve("local")).toBe("src/local.ts");
    expect(await resolve("from-base")).toBe("src/from-base.ts");
  });

  it("refuses duplicate workspace names instead of choosing an arbitrary checkout path", async () => {
    const { resolve } = snapshot(
      ["packages/a/index.ts", "packages/b/index.ts"],
      {
        "packages/a/package.json": '{"name":"duplicate","main":"index.ts"}',
        "packages/b/package.json": '{"name":"duplicate","main":"index.ts"}',
      },
    );
    expect(await resolve("duplicate")).toBeNull();
  });

  it("never guesses by basename or reads outside the snapshot", async () => {
    const { resolve, readText } = snapshot([
      "somewhere/Button.ts",
      "node_modules/react/index.js",
    ]);
    for (const specifier of [
      "Button",
      "react",
      "missing",
      "../../../secret",
      "/../secret",
      "//host/file",
      "https://host/file",
      "file:///secret",
      "node:fs",
      "fs/promises",
      "path",
      "C:/secret",
      "./nul\0.ts",
      "..\\secret",
    ]) {
      expect(await resolve(specifier)).toBeNull();
    }
    expect(readText).not.toHaveBeenCalled();
  });

  it("rejects escaping alias/exports targets and unsupported external config extends", async () => {
    const { resolve, readText } = snapshot(["outside.ts"], {
      "tsconfig.json":
        '{"extends":"remote-config","compilerOptions":{"paths":{"@bad":["../outside.ts"]}}}',
      "packages/pkg/package.json":
        '{"name":"pkg","exports":{".":"../../../outside.ts"}}',
    });
    expect(await resolve("@bad")).toBeNull();
    expect(await resolve("pkg")).toBeNull();
    expect(
      readText.mock.calls.every(([path]) => path !== "remote-config"),
    ).toBe(true);
  });

  it("refuses dependency and Git metadata targets even when exact paths or aliases declare them", async () => {
    const { resolve, readText } = snapshot(
      [
        "node_modules/pkg/index.ts",
        ".git/config",
        "src/pages/node_modules/pkg.ts",
      ],
      {
        "tsconfig.json":
          '{"extends":"./node_modules/config/base.json","compilerOptions":{"paths":{"@dependency":["node_modules/pkg/index"],"@metadata":[".git/config"]}}}',
        "node_modules/config/base.json": '{"compilerOptions":{"baseUrl":"."}}',
      },
    );
    for (const specifier of [
      "../../node_modules/pkg/index",
      "../../.git/config",
      "./node_modules/pkg",
      "@dependency",
      "@metadata",
    ]) {
      expect(await resolve(specifier)).toBeNull();
    }
    expect(
      readText.mock.calls.every(
        ([path]) =>
          !path
            .split("/")
            .some((part) => part === "node_modules" || part === ".git"),
      ),
    ).toBe(true);
  });

  it("bounds local extends cycles and reads each config at most once per activation", async () => {
    const { resolve, readText } = snapshot(["src/target.ts"], {
      "tsconfig.json":
        '{"extends":"./base.json","compilerOptions":{"paths":{"@ok":["src/target"]}}}',
      "base.json": '{"extends":"./tsconfig.json"}',
    });
    expect(await resolve("@ok")).toBe("src/target.ts");
    expect(readText.mock.calls.map(([path]) => path).sort()).toEqual([
      "base.json",
      "tsconfig.json",
    ]);
  });

  it("caps config depth and manifest reads even when the snapshot contains thousands of packages", async () => {
    const configs = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        index === 0 ? "tsconfig.json" : `config-${index}.json`,
        JSON.stringify({ extends: `./config-${index + 1}.json` }),
      ]),
    );
    const manifests = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [
        `packages/pkg-${index}/package.json`,
        JSON.stringify({ name: `pkg-${index}`, source: "index.ts" }),
      ]),
    );
    const { resolve, readText, paths } = snapshot([], {
      ...configs,
      ...manifests,
    });
    expect(await resolve("unknown-external-package")).toBeNull();
    expect(readText.mock.calls.length).toBeLessThanOrEqual(48);
    expect(readText.mock.calls.every(([path]) => paths.has(path))).toBe(true);
  });

  it("treats unreadable/malformed/oversized configs as unresolved without throwing", async () => {
    const { paths, resolve } = snapshot([], {
      "tsconfig.json": "/* unfinished",
    });
    expect(await resolve("@unknown")).toBeNull();
    expect(
      await resolvePrImport({
        sourcePath: SOURCE,
        specifier: "@unknown",
        paths,
        readText: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeNull();
    const huge = snapshot([], { "tsconfig.json": " ".repeat(300_000) });
    expect(await huge.resolve("@unknown")).toBeNull();
  });
});
