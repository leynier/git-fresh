import { describe, expect, test } from "bun:test";
import { selectEnvironmentFiles } from "../src/environment-files.js";

describe("environment file selection", () => {
  test("does not prompt when there are no environment files", async () => {
    let prompted = false;

    const result = await selectEnvironmentFiles([], async () => {
      prompted = true;
      return "all";
    });

    expect(result).toEqual([]);
    expect(prompted).toBe(false);
  });

  test("protects all environment files", async () => {
    const files = [".env", "packages/app/.env.local"];

    const result = await selectEnvironmentFiles(files, async (question) => {
      expect(question.default).toBe("all");
      expect(question.choices).toHaveLength(3);
      return "all";
    });

    expect(result).toEqual(files);
    expect(result).not.toBe(files);
  });

  test("can leave every environment file unprotected", async () => {
    const result = await selectEnvironmentFiles([".env"], async () => "none");

    expect(result).toEqual([]);
  });

  test("returns the individually selected environment files", async () => {
    const files = [".env", "packages/app/.env.local"];

    const result = await selectEnvironmentFiles(
      files,
      async () => "select",
      async (question) => {
        expect(question.choices).toEqual([
          { name: ".env", value: ".env", checked: true },
          {
            name: "packages/app/.env.local",
            value: "packages/app/.env.local",
            checked: true,
          },
        ]);
        return [".env"];
      },
    );

    expect(result).toEqual([".env"]);
  });
});
