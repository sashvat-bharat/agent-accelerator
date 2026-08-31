import { Agent, tool, z } from "agent-accelerator";

const get_status = tool({
  name: "get_status",
  description: "Checks user authentication status in database.",
  input: z.object({username: z.string()}),
  execute: async ({ username }) => {
    if (username === "Akshat Dwivedi") {
      return "Valid username. Welcome to Home, Sir!";
    }
    return "Invalid username";
  },
});

const agent = new Agent({
  name: "Authentication Agent",
  instructions: "You are a precise function-calling assistant. When asked to verify users, call get_status.",
  model: process.env.MODEL,
  tools: {get_status},
  ThinkingLevel: "low",
});

const response = await agent.ask("Check the status for username: Akshat Dwivedi");
console.log("Response:", response.text);
console.log("Tool Calls:", response.toolCalls);
console.log("Usage:", response.usage);
