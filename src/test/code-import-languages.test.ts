import { describe, expect, it } from "vitest";
import {
  languageForPath,
  scanCodeImports,
  supportsCodeImports,
} from "@/features/pulls/code-import-languages";

describe("dependency language detection", () => {
  it.each([
    ["src/app.tsx", "javascript"],
    ["app.mjs", "javascript"],
    ["app.cts", "javascript"],
    ["App.vue", "javascript"],
    ["App.svelte", "javascript"],
    ["page.astro", "javascript"],
    ["app.py", "python"],
    ["types.pyi", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["App.java", "jvm"],
    ["App.kt", "jvm"],
    ["script.kts", "jvm"],
    ["app.cpp", "c"],
    ["app.h", "c"],
    ["App.mm", "c"],
    ["App.cs", "csharp"],
    ["app.php", "php"],
    ["app.rb", "ruby"],
    ["App.swift", "swift"],
    ["app.dart", "dart"],
  ])("detects %s explicitly", (path, language) => {
    expect(languageForPath(path)).toBe(language);
    expect(supportsCodeImports(path)).toBe(true);
  });
  it.each([
    "README.md",
    "app.json",
    "template.html",
    "plain.txt",
    "binary.png",
  ])("does not guess a language for %s", (path) => {
    expect(languageForPath(path)).toBeNull();
    expect(supportsCodeImports(path)).toBe(false);
    expect(scanCodeImports('import x from "./fake";', path)).toEqual([]);
  });
});

describe("native dependency directives", () => {
  it.each([
    [
      "app.dart",
      "const text = 'import' 'local.dart';\nimport 'actual.dart';",
      ["actual.dart"],
    ],
    [
      "app.dart",
      "const text = 'export' 'local.dart';\nexport 'actual.dart';",
      ["actual.dart"],
    ],
    [
      "app.dart",
      "const text = 'part' 'local.dart';\npart 'actual.dart';",
      ["actual.dart"],
    ],
    ["app.rb", "text = 'require' 'local'\nrequire 'actual'\n", ["actual"]],
    [
      "app.rb",
      "text = 'require_relative' 'local'\nrequire_relative 'actual'\n",
      ["actual"],
    ],
    [
      "app.rb",
      "class String\n def require(path); path; end\nend\n'Kernel'.require('local')\nKernel.require('actual')\n",
      ["actual"],
    ],
  ])(
    "requires directive words rather than quoted token values in %s",
    (path, source, expected) => {
      expect(
        scanCodeImports(source, path).map((item) => item.specifier),
      ).toEqual(expected);
    },
  );

  it("keeps Ruby block comments opaque until a column-zero end marker with exact offsets", () => {
    const source =
      "# 😀\r\n=begin documentation\r\nrequire_relative 'commented/first'\r\n  =end\r\nrequire_relative 'commented/second'\r\n=end documentation\r\nrequire_relative 'actual/dependency'\r\n";
    const imports = scanCodeImports(source, "app.rb");
    expect(imports.map((item) => item.specifier)).toEqual([
      "actual/dependency",
    ]);
    expect(imports[0].from).toBe(source.indexOf("actual/dependency"));
    expect(source.slice(imports[0].from, imports[0].to)).toBe(
      "actual/dependency",
    );
  });

  it("stops Ruby directives at column-zero __END__ data while preserving earlier imports", () => {
    const source =
      "# 😀\r\nrequire_relative 'actual/dependency'\r\n__END__\r\nrequire_relative 'data/hidden'\r\n=begin\r\nrequire 'data/also-hidden'\r\n";
    const imports = scanCodeImports(source, "app.rb");
    expect(imports.map((item) => item.specifier)).toEqual([
      "actual/dependency",
    ]);
    expect(imports[0].from).toBe(source.indexOf("actual/dependency"));
  });

  it("does not treat indented Ruby identifiers or marker prefixes as data boundaries", () => {
    const source =
      "__END__suffix = true\n  __END__ = 'ordinary identifier'\nrequire_relative 'actual/dependency'\n";
    expect(
      scanCodeImports(source, "app.rb").map((item) => item.specifier),
    ).toEqual(["actual/dependency"]);
  });

  it("does not interpret Ruby block or data markers inside a heredoc", () => {
    const source =
      "text = <<~DOC\n=begin\n__END__\n=end\nrequire_relative 'heredoc/hidden'\nDOC\nrequire_relative 'actual/dependency'\n";
    expect(
      scanCodeImports(source, "app.rb").map((item) => item.specifier),
    ).toEqual(["actual/dependency"]);
  });

  it.each([
    [
      "app.py",
      "import os.path as path, project.helpers\n",
      ["os.path", "project.helpers"],
    ],
    [
      "app.py",
      "from ..package import (\n submodule as alias,\n other,\n)\n",
      ["..package", "..package.submodule", "..package.other"],
    ],
    ["app.py", "from . import sibling\n", [".", ".sibling"]],
    [
      "main.go",
      'package main\nimport "example.org/pkg"\nimport (\n alias "example.org/other"\n _ `example.org/setup`\n)\n',
      ["example.org/pkg", "example.org/other", "example.org/setup"],
    ],
    [
      "lib.rs",
      "use crate::net::{self, Socket as Alias, sub::{Thing, other::*}};\npub mod external;\nmod inline {}\n",
      [
        "crate::net",
        "crate::net::Socket",
        "crate::net::sub::Thing",
        "crate::net::sub::other",
        "external",
      ],
    ],
    [
      "App.java",
      "package app;\nimport java.util.List;\nimport static project.Math.max;\n",
      ["java.util.List", "project.Math.max"],
    ],
    [
      "App.kt",
      "import project.data.Value as Alias\nimport project.tools.*\n",
      ["project.data.Value", "project.tools.*"],
    ],
    [
      "app.cpp",
      '# include "local/header.h"\n#include <project/api.h>\n#include HEADER_MACRO\n',
      ["local/header.h", "project/api.h"],
    ],
    [
      "App.mm",
      '#import "Local.h"\n#import <Foundation/Foundation.h>\n',
      ["Local.h", "Foundation/Foundation.h"],
    ],
    [
      "app.cpp",
      "export import project.api;\nimport project.core:detail;\n",
      ["project.api", "project.core:detail"],
    ],
    [
      "App.cs",
      "global using Project.Data;\nusing static Project.Tools.Math;\nusing Alias = Project.Data.Value;\nusing var stream = Open();\nusing (var other = Open()) {}\n",
      ["Project.Data", "Project.Tools.Math", "Project.Data.Value"],
    ],
    [
      "app.php",
      "<?php\nuse Vendor\\Package\\{Thing, Sub\\Other as Alias};\nuse function Vendor\\Tools\\helper;\nrequire_once __DIR__ . '/bootstrap.php';\ninclude('../view.php');\n",
      [
        "Vendor\\Package\\Thing",
        "Vendor\\Package\\Sub\\Other",
        "Vendor\\Tools\\helper",
        "./bootstrap.php",
        "../view.php",
      ],
    ],
    [
      "app.rb",
      "require 'project/core'\nrequire_relative '../support'\nKernel.require(\"project/setup\")\nobject.require('not-a-dependency')\n",
      ["project/core", "../support", "project/setup"],
    ],
    [
      "App.swift",
      "@testable import ProjectKit\nimport struct ProjectModels.Value\n",
      ["ProjectKit", "ProjectModels.Value"],
    ],
    [
      "app.dart",
      "import 'stub.dart' if (dart.library.io) 'io.dart';\nexport r'../api.dart';\npart 'generated.g.dart';\npart of my.library;\n",
      ["stub.dart", "io.dart", "../api.dart", "generated.g.dart"],
    ],
  ])("finds grammar-specific imports in %s", (path, source, expected) => {
    const imports = scanCodeImports(source, path);
    expect(imports.map((item) => item.specifier)).toEqual(expected);
    let end = 0;
    for (const item of imports) {
      expect(item.from).toBeGreaterThanOrEqual(end);
      expect(item.to).toBeGreaterThan(item.from);
      expect(item.to).toBeLessThanOrEqual(source.length);
      end = item.to;
    }
  });

  it.each([
    [
      "app.py",
      "# import fake\ntext = r'''\nfrom fake import hidden\n'''\nimport real\n",
      ["real"],
    ],
    [
      "main.go",
      'package main\nvar text = `import "fake"`\n/* import "fake2" */\nimport "real"\n',
      ["real"],
    ],
    [
      "lib.rs",
      'const TEXT: &str = r###"use fake::Hidden; mod fake;"###;\n/* outer /* use fake; */ comment */\nuse crate::real::Thing;\n',
      ["crate::real::Thing"],
    ],
    [
      "App.kt",
      'val text = """import fake.Hidden"""\n// import fake.Hidden\nimport real.Value\n',
      ["real.Value"],
    ],
    [
      "app.cpp",
      'const auto text = R"tag(\n#include "fake.h"\n)tag";\n// #include "fake2.h"\n#include "real.h"\n',
      ["real.h"],
    ],
    [
      "App.cs",
      'var text = @"using Fake.Hidden;";\nvar raw = """using Fake.Raw;""";\nusing Real.Values;\n',
      ["Real.Values"],
    ],
    [
      "app.php",
      "<p>require 'fake.php';</p><?php\n$text = <<<'DOC'\nuse Fake\\Hidden;\nrequire 'hidden.php';\nDOC;\nrequire 'real.php';\n",
      ["real.php"],
    ],
    [
      "app.rb",
      "text = <<~DOC\nrequire 'hidden'\nDOC\nraw = %q{require 'fake'}\nrequire 'real'\n",
      ["real"],
    ],
    [
      "App.swift",
      'let text = #"""\nimport Fake\n"""#\n/* import Hidden */\nimport RealKit\n',
      ["RealKit"],
    ],
    [
      "app.dart",
      "final text = r'''import 'hidden.dart';''';\n// import 'fake.dart';\nimport 'real.dart';\n",
      ["real.dart"],
    ],
  ])("ignores comments and inert strings in %s", (path, source, expected) => {
    expect(scanCodeImports(source, path).map((item) => item.specifier)).toEqual(
      expected,
    );
  });

  it("keeps only the resolver distinctions that need a kind", () => {
    const examples = [
      ["lib.rs", "use crate::foo; mod bar;", ["rust-use", "rust-mod"]],
      [
        "app.cpp",
        '#include "a.h"\n#include <b.h>\nimport project.api;',
        ["c-include-quoted", "c-include-system", "c-module"],
      ],
      [
        "app.php",
        "<?php use A\\B; require 'x.php';",
        ["php-use", "php-include"],
      ],
      [
        "app.rb",
        "require 'a'\nrequire_relative 'b'",
        ["ruby-require", "ruby-require-relative"],
      ],
    ] as const;
    for (const [path, source, kinds] of examples)
      expect(scanCodeImports(source, path).map((item) => item.kind)).toEqual(
        kinds,
      );
    expect(scanCodeImports("import os", "app.py")[0]?.kind).toBeUndefined();
  });

  it("retains exact line-ending and UTF-16 offsets while qualifying grouped members", () => {
    const source = "# 😀\r\nfrom package import submodule as Alias\r\n";
    const imports = scanCodeImports(source, "app.py");
    expect(
      imports.map((item) => [source.slice(item.from, item.to), item.specifier]),
    ).toEqual([
      ["package", "package"],
      ["submodule", "package.submodule"],
    ]);
  });
  it("never applies another language's directive grammar", () => {
    expect(scanCodeImports("using Project.Data;", "app.py")).toEqual([]);
    expect(scanCodeImports('import value from "./js-only";', "App.cs")).toEqual(
      [],
    );
  });
  it("bounds work and returned candidates", () => {
    expect(scanCodeImports("import x\n".repeat(60_000), "app.py")).toEqual([]);
    expect(
      scanCodeImports("import x\n".repeat(2_000), "app.py").length,
    ).toBeLessThanOrEqual(1_000);
  });
});

describe("JavaScript framework contexts", () => {
  it("delegates JavaScript and TSX without treating JSX text as imports", () => {
    const source =
      'const node = <p>import value from "./fake";</p>; const actual = import("./real");';
    expect(
      scanCodeImports(source, "view.tsx").map((item) => item.specifier),
    ).toEqual(["./real"]);
  });
  it.each(["App.vue", "App.svelte"])(
    "scans only top-level script bodies in %s",
    (path) => {
      const source =
        '<!-- <script>import fake from "./comment";</script> -->\n<template><p>import fake from "./template";</p></template>\n<script lang="ts">\nimport actual from "./real";\n</script>\n<style>.x { content: "import fake from ./css"; }</style>';
      const imports = scanCodeImports(source, path);
      expect(imports.map((item) => item.specifier)).toEqual(["./real"]);
      expect(source.slice(imports[0].from, imports[0].to)).toBe("./real");
    },
  );
  it("does not treat JSON script data as JavaScript", () => {
    expect(
      scanCodeImports(
        '<script type="application/json">{"text":"import fake from \'./fake\'"}</script>',
        "App.vue",
      ),
    ).toEqual([]);
  });
  it("restricts Astro to its initial frontmatter and keeps absolute offsets", () => {
    const source =
      '---\r\nimport actual from "./real";\r\n---\r\n<p>import fake from "./template";</p>';
    const imports = scanCodeImports(source, "page.astro");
    expect(imports.map((item) => item.specifier)).toEqual(["./real"]);
    expect(source.slice(imports[0].from, imports[0].to)).toBe("./real");
  });
});
