import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "../src/version";
import { Layout } from "../src/web/layout";

describe("APP_VERSION", () => {
  test("is a plain X.Y.Z version, so it can be tagged vX.Y.Z", () => {
    expect(APP_VERSION).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });

  test("matches the Apple apps' MARKETING_VERSION", () => {
    const projectYml = readFileSync(join(import.meta.dir, "../../apple/project.yml"), "utf8");
    const versions = [...projectYml.matchAll(/^\s*MARKETING_VERSION:\s*"?([^"\s]+)"?\s*$/gm)].map((m) => m[1]);
    expect(versions).toEqual([APP_VERSION]);
  });

  test("is shown on every web page", async () => {
    const html = String(await (<Layout title="t">body</Layout>).toString());
    expect(html).toContain(`<footer class="version">v${APP_VERSION}</footer>`);
  });
});
