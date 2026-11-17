import { describe, expect, it, vi } from "vitest";
import { resolveCodeImportCandidates } from "@/features/pulls/code-import-resolution";

function snapshot(
  sourcePath: string,
  files: string[],
  texts: Record<string, string> = {},
) {
  const paths = new Set([sourcePath, ...files, ...Object.keys(texts)]);
  const readText = vi.fn(async (path: string) => {
    if (!paths.has(path)) throw new Error(`Outside snapshot: ${path}`);
    return texts[path] ?? null;
  });
  return {
    paths,
    readText,
    resolve: (specifier: string, kind?: string) =>
      resolveCodeImportCandidates({
        sourcePath,
        specifier,
        kind,
        paths,
        readText,
      }),
  };
}

describe("snapshot code import candidates", () => {
  it("delegates JS/TS paths to the existing snapshot resolver", async () => {
    const { resolve, readText } = snapshot("src/View.tsx", [
      "src/components/Button.tsx",
    ]);
    expect(await resolve("./components/Button")).toEqual([
      "src/components/Button.tsx",
    ]);
    expect(readText).not.toHaveBeenCalled();
  });

  it("resolves Python absolute/relative modules, packages, and imported symbol tails", async () => {
    const { resolve } = snapshot("src/pkg/views/page.py", [
      "src/pkg/__init__.py",
      "src/pkg/views/__init__.py",
      "src/pkg/models/user.py",
    ]);
    expect(await resolve("pkg.models.user.User")).toEqual([
      "src/pkg/models/user.py",
    ]);
    expect(await resolve("..models.user")).toEqual(["src/pkg/models/user.py"]);
    expect(await resolve("pkg")).toEqual(["src/pkg/__init__.py"]);
    expect(await resolve(".Page")).toEqual(["src/pkg/views/__init__.py"]);
    expect(await resolve("....outside")).toEqual([]);
    expect(await resolve("os.path")).toEqual([]);
  });

  it("keeps Python imports in the nearest project instead of another checkout package", async () => {
    const { resolve } = snapshot("apps/web/src/pkg/view.py", [
      "apps/web/pyproject.toml",
      "apps/web/src/shared/helper.py",
      "apps/other/src/shared/helper.py",
    ]);
    expect(await resolve("shared.helper")).toEqual([
      "apps/web/src/shared/helper.py",
    ]);
    expect(await resolve("requests")).toEqual([]);
  });

  it("resolves Go workspace module packages to all implementation files", async () => {
    const { resolve } = snapshot(
      "apps/api/main.go",
      [
        "libs/common/log/read.go",
        "libs/common/log/write.go",
        "libs/common/log/read_test.go",
        "fixtures/common/log/unrelated.go",
        "apps/api/nested/pkg/unrelated.go",
      ],
      {
        "go.work": "go 1.23\nuse (\n ./apps/api\n ./libs/common\n)\n",
        "apps/api/go.mod": "module example.test/api\n",
        "libs/common/go.mod": 'module "example.test/common"\n',
        "fixtures/common/go.mod": "module example.test/common\n",
        "apps/api/nested/go.mod": "module example.test/separate\n",
      },
    );
    expect(await resolve("example.test/common/log")).toEqual([
      "libs/common/log/read.go",
      "libs/common/log/write.go",
    ]);
    expect(await resolve("fmt")).toEqual([]);
    expect(await resolve("github.com/external/pkg")).toEqual([]);
    expect(await resolve("example.test/api/nested/pkg")).toEqual([]);
  });

  it("does not treat unrelated Go module manifests as workspace membership", async () => {
    const { resolve } = snapshot(
      "apps/api/main.go",
      ["fixtures/other/foo.go"],
      {
        "apps/api/go.mod": "module example.test/api\n",
        "fixtures/other/go.mod": "module example.test/other\n",
      },
    );
    expect(await resolve("example.test/other")).toEqual([]);
  });

  it.each([
    ["crate::models::User", "rust-use", "src/models.rs"],
    ["self::codec::decode", "rust-use", "src/net/client/codec.rs"],
    ["super::server::run", "rust-use", "src/net/server.rs"],
    ["worker", "rust-mod", "src/net/client/worker/mod.rs"],
  ])(
    "resolves Rust %s using module grammar",
    async (specifier, kind, target) => {
      const { resolve } = snapshot("src/net/client.rs", [
        "Cargo.toml",
        "src/lib.rs",
        target,
      ]);
      expect(await resolve(specifier, kind)).toEqual([target]);
      expect(await resolve("std::io::Read", "rust-use")).toEqual([]);
      expect(await resolve("serde::Deserialize", "rust-use")).toEqual([]);
    },
  );

  it("resolves JVM classes/static members and package wildcard choices from project source roots", async () => {
    const { resolve } = snapshot("app/src/main/java/com/acme/View.java", [
      "app/pom.xml",
      "app/src/main/java/com/acme/Utils.java",
      "app/src/main/kotlin/com/acme/Model.kt",
      "other/src/main/java/com/acme/Utils.java",
    ]);
    expect(await resolve("com.acme.Utils.MAX")).toEqual([
      "app/src/main/java/com/acme/Utils.java",
    ]);
    expect(await resolve("com.acme.*")).toEqual(
      expect.arrayContaining([
        "app/src/main/java/com/acme/Utils.java",
        "app/src/main/kotlin/com/acme/Model.kt",
      ]),
    );
    expect(await resolve("java.util.List")).toEqual([]);
  });

  it("finds Kotlin top-level imports by bounded declaration proof in the qualified package", async () => {
    const { resolve } = snapshot("app/src/main/kotlin/com/acme/View.kt", [], {
      "app/build.gradle.kts": "plugins {}",
      "app/src/main/kotlin/com/acme/Helpers.kt":
        "package com.acme\nfun parseThing() = 1",
      "app/src/main/kotlin/com/acme/Decoy.kt":
        'package com.other\nval example = """\none " quote\npackage com.acme\nfun parseThing() = 2\n"""',
      "other/Helpers.kt": "package com.acme\nfun parseThing() = 2",
    });
    expect(await resolve("com.acme.parseThing")).toEqual([
      "app/src/main/kotlin/com/acme/Helpers.kt",
    ]);
  });

  it("resolves quoted C/C++ includes relative to source and system includes only in project roots", async () => {
    const { resolve } = snapshot("app/src/main.cpp", [
      "app/CMakeLists.txt",
      "app/src/local.h",
      "app/include/project/api.hpp",
      "other/include/project/api.hpp",
    ]);
    expect(await resolve("local.h", "c-include-quoted")).toEqual([
      "app/src/local.h",
    ]);
    expect(await resolve("project/api.hpp", "c-include-system")).toEqual([
      "app/include/project/api.hpp",
    ]);
    expect(await resolve("vector", "c-include-system")).toEqual([]);
    expect(await resolve("stdio.h", "c-include-system")).toEqual([]);
  });

  it("resolves C++ module imports only from matching local module declarations", async () => {
    const { resolve } = snapshot("app/src/main.cpp", ["app/CMakeLists.txt"], {
      "app/modules/Arithmetic.ixx":
        "export module acme.math;\nexport int add(int a, int b);",
      "app/modules/Wrong.cppm":
        'export module acme.wrong;\nconst char* doc = R"sample(one " quote\nexport module acme.math;\n)sample";',
      "other/Math.cppm": "export module acme.math;",
    });
    expect(await resolve("acme.math", "c-module")).toEqual([
      "app/modules/Arithmetic.ixx",
    ]);
    expect(await resolve("std", "c-module")).toEqual([]);
  });

  it("resolves C# namespace/type declarations within the owning project", async () => {
    const { resolve } = snapshot("app/View.cs", [], {
      "app/App.csproj":
        "<Project><PropertyGroup><RootNamespace>Acme</RootNamespace></PropertyGroup></Project>",
      "app/Services/Handler.cs":
        "namespace Acme.Services;\npublic class Handler {}",
      "app/Shared.cs": "namespace Acme.Services;\npublic class Shared {}",
      "other/Handler.cs": "namespace Acme.Services;\npublic class Handler {}",
      "app/Nested/Nested.csproj": "<Project/>",
      "app/Nested/Handler.cs":
        "namespace Acme.Services;\npublic class Handler {}",
      "app/Decoy.cs":
        'var example = """\none " quote\nnamespace Acme.Services;\nclass Handler {}\n""";',
    });
    expect(await resolve("Acme.Services")).toEqual([
      "app/Services/Handler.cs",
      "app/Shared.cs",
    ]);
    expect(await resolve("Acme.Services.Handler")).toEqual([
      "app/Services/Handler.cs",
    ]);
    expect(await resolve("System.Text")).toEqual([]);
  });

  it("uses PHP composer PSR-4 mappings and keeps includes relative", async () => {
    const { resolve } = snapshot(
      "app/src/View.php",
      [
        "app/src/Service/User.php",
        "app/config/settings.php",
        "vendor/external/User.php",
      ],
      {
        "app/composer.json": JSON.stringify({
          autoload: { "psr-4": { "Acme\\": "src/" } },
        }),
      },
    );
    expect(await resolve("Acme\\Service\\User", "php-use")).toEqual([
      "app/src/Service/User.php",
    ]);
    expect(await resolve("../config/settings.php", "php-include")).toEqual([
      "app/config/settings.php",
    ]);
    expect(await resolve("External\\User", "php-use")).toEqual([]);
  });

  it("distinguishes Ruby require_relative from project lib require", async () => {
    const { resolve } = snapshot("app/lib/views/view.rb", [
      "app/Gemfile",
      "app/lib/models/user.rb",
      "app/lib/helpers/logger.rb",
      "other/lib/helpers/logger.rb",
    ]);
    expect(await resolve("../models/user", "ruby-require-relative")).toEqual([
      "app/lib/models/user.rb",
    ]);
    expect(await resolve("helpers/logger", "ruby-require")).toEqual([
      "app/lib/helpers/logger.rb",
    ]);
    expect(await resolve("json", "ruby-require")).toEqual([]);
    expect(await resolve("external_gem", "ruby-require")).toEqual([]);
  });

  it("offers Swift module files and resolves qualified symbols by declaration", async () => {
    const { resolve } = snapshot("Sources/App/View.swift", ["Package.swift"], {
      "Sources/Core/Models.swift": "public struct User {}",
      "Sources/Core/Helpers.swift":
        'public func helper() {}\nlet example = """\none " quote\npublic struct User {}\n"""',
      "Other/Models.swift": "public struct User {}",
    });
    expect(await resolve("Core")).toEqual([
      "Sources/Core/Helpers.swift",
      "Sources/Core/Models.swift",
    ]);
    expect(await resolve("Core.User")).toEqual(["Sources/Core/Models.swift"]);
    expect(await resolve("Foundation")).toEqual([]);
  });

  it("resolves Dart relative and the owning pubspec package while refusing dart/external URIs", async () => {
    const { resolve } = snapshot(
      "app/lib/views/view.dart",
      ["app/lib/models/user.dart"],
      {
        "app/pubspec.yaml": "name: acme_app\ndescription: local app\n",
      },
    );
    expect(await resolve("../models/user.dart")).toEqual([
      "app/lib/models/user.dart",
    ]);
    expect(await resolve("package:acme_app/models/user.dart")).toEqual([
      "app/lib/models/user.dart",
    ]);
    expect(await resolve("package:external/user.dart")).toEqual([]);
    expect(await resolve("dart:core")).toEqual([]);
    expect(await resolve("package:acme_app/../../secret.dart")).toEqual([]);
  });

  it.each([
    "../../../secret.h",
    "/etc/secret.h",
    "https://host/header.h",
    "./nul\0.h",
    "../node_modules/pkg/a.h",
    "../.git/config",
  ])("refuses unsafe or external include %s", async (specifier) => {
    const { resolve, readText } = snapshot("src/main.cpp", [
      "node_modules/pkg/a.h",
      ".git/config",
      "secret.h",
    ]);
    expect(await resolve(specifier, "c-include-quoted")).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });

  it("caps package choices at 64 exact paths", async () => {
    const { resolve, paths } = snapshot(
      "main.go",
      Array.from(
        { length: 100 },
        (_, index) => `pkg/file-${String(index).padStart(3, "0")}.go`,
      ),
      {
        "go.mod": "module example.test/app\n",
      },
    );
    const candidates = await resolve("example.test/app/pkg");
    expect(candidates).toHaveLength(64);
    expect(candidates).toEqual([...candidates].sort());
    expect(candidates.every((path) => paths.has(path))).toBe(true);
  });

  it("bounds namespace proof reads, rejects oversized/unreadable text, and never probes outside the snapshot", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `app/Other${index}.cs`,
        "namespace Other; class No {}",
      ]),
    );
    const { resolve, readText, paths } = snapshot("app/View.cs", [], {
      ...files,
      "app/App.csproj":
        "<Project><RootNamespace>Wanted</RootNamespace></Project>",
      "app/User.cs": `namespace Wanted; class User {}${" ".repeat(400_001)}`,
    });
    expect(await resolve("Wanted.User")).toEqual([]);
    expect(readText.mock.calls.some(([path]) => path === "app/User.cs")).toBe(
      true,
    );
    expect(readText.mock.calls.length).toBeLessThanOrEqual(48);
    expect(readText.mock.calls.every(([path]) => paths.has(path))).toBe(true);
    expect(
      await resolveCodeImportCandidates({
        sourcePath: "View.cs",
        specifier: "Wanted",
        paths: new Set(["View.cs"]),
        readText: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toEqual([]);
  });
});
