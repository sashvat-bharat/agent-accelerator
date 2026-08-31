import { describe, it, expect } from "bun:test";
import { defineSkill, tool, z } from "../src/index.ts";

describe("Skills Subsystem", () => {
  it("should define a skill with instructions and tools", () => {
    const weatherTool = tool({
      name: "get_weather",
      description: "Gets weather info",
      input: z.object({ city: z.string() }),
      execute: ({ city }) => ({ city, temp: 25 }),
    });

    const weatherSkill = defineSkill({
      name: "Weather Expert",
      description: "Specialized skill for weather data retrieval",
      instructions: "Always return temperatures in Celsius.",
      tools: {
        get_weather: weatherTool,
      },
    });

    expect(weatherSkill.name).toBe("Weather Expert");
    expect(weatherSkill.instructions).toBe("Always return temperatures in Celsius.");
    expect(weatherSkill.tools["get_weather"]).toBeDefined();
  });
});
