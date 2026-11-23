// The version the SDK reports in its User-Agent header is the one in its own package.json, however the app that uses it
// was started (`bun run` and `npm run` set npm_package_version to the version of the APP, not of the SDK).
import { describe, it, expect } from "bun:test";
import pkg from "../package.json";
import { buildSessionHeaders } from "../src/utils/headers.ts";

describe("the SDK version", () => {
  it("is a plain x.y.z version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("goes into the User-Agent from package.json, not from the host app's npm_package_version", () => {
    const before = process.env["npm_package_version"];
    process.env["npm_package_version"] = "7.7.7";
    try {
      expect(buildSessionHeaders("google")["User-Agent"]).toBe(`Agent-Accelerator/${pkg.version}`);
    } finally {
      if (before === undefined) delete process.env["npm_package_version"];
      else process.env["npm_package_version"] = before;
    }
  });
});
