import { Agent, SubAgent, tool, z } from "agent-accelerator";
import { fail } from "./_shared";

// 1. Standard Function Tool (Tools are strictly deterministic functions)
const get_topic_brief = tool({
  name: "get_topic_brief",
  description: "Fetch comprehensive technical briefing, baseline metrics, and industry parameters for a target domain.",
  input: z.object({
    topic: z.string().describe("Topic or technology to retrieve the briefing for"),
  }),
  execute: async ({ topic }) => {
    return {
      topic,
      maturityLevel: "TRL 6-7 (Technology Readiness Level: System prototype demonstration in operational environment)",
      executiveSummary:
        "Solid-State Batteries (SSBs) represent the critical frontier in automotive electrochemical energy storage, replacing volatile flammable liquid organic carbonate electrolytes with solid ionic conductors. Key commercialization milestones center around stabilizing the solid electrolyte-lithium metal interface, maintaining uniform stack pressure during volume expansion/contraction cycling, and achieving cost-effective continuous roll-to-roll manufacturing in ultra-dry atmospheric cleanrooms.",
      coreChemistryFamilies: [
        {
          family: "Sulfide-Based (e.g. Argyrodites Li6PS5Cl, LGPS)",
          roomTemperatureConductivity: "1.0 - 1.2 x 10^-2 S/cm (approaching liquid electrolyte levels)",
          advantages: "High room-temperature ionic conductivity, favorable mechanical ductility enabling cold-press densification without extreme heat sintering",
          criticalDrawbacks: "Moisture sensitivity producing hazardous H2S toxic gas; narrow electrochemical stability window against metallic lithium anode requiring protective interlayers; high precursor cost (> $100/kg for battery-grade Li2S)",
          leadingKeyPlayers: ["Toyota / Idemitsu Kosan", "Samsung SDI", "Solid Power / BMW / Ford", "SK On"],
        },
        {
          family: "Oxide-Based (e.g. Garnet LLZO Li7La3Zr2O12, NASICON)",
          roomTemperatureConductivity: "1.0 - 1.5 x 10^-3 S/cm",
          advantages: "Broad electrochemical stability window (> 4.5V allowing high-voltage nickel/manganese cathodes); superior thermal runaway safety (> 1000°C); robust mechanical resistance against lithium dendrite penetration",
          criticalDrawbacks: "Extreme ceramic brittleness; requires high-temperature sintering (> 1050°C) limiting high-speed roll-to-roll throughput; high solid-solid interfacial contact impedance causing high internal resistance",
          leadingKeyPlayers: ["QuantumScape (ceramic separator platform)", "ProLogium", "WeLion (hybrid semi-solid)", "Gotion High-Tech"],
        },
        {
          family: "Polymer / Solid-State Composite (e.g. PEO, PAN, PVDF-HFP with ceramic fillers)",
          roomTemperatureConductivity: "1.0 x 10^-4 S/cm (poor at 25°C; acceptable at 50-70°C)",
          advantages: "Direct compatibility with existing gigafactory roll-to-roll slurry coating and calendering lines; excellent flexibility and pouch packaging adaptability",
          criticalDrawbacks: "Requires auxiliary thermal management systems to sustain operating temperatures (60-80°C); restricted C-rate fast charging; lower gravimetric energy density",
          leadingKeyPlayers: ["Blue Solutions (Bolloré)", "Factorial Energy", "Mercedes-Benz / Stellantis pilot fleets"],
        },
      ],
      targetEngineeringMetrics: {
        gravimetricEnergyDensity: "Target: 450 - 500 Wh/kg (vs current NMC811 liquid cells at ~270-300 Wh/kg)",
        volumetricEnergyDensity: "Target: 950 - 1,150 Wh/L (vs current liquid cells at ~700-750 Wh/L, allowing 30-40% smaller battery pack envelopes)",
        fastChargingRate: "Target: 10% to 80% State of Charge in 10-12 minutes under continuous 4C-6C pulse currents",
        cyclingDurability: "Target: >= 1,200 full 80% DoD cycles with > 80% capacity retention under 25°C automotive load profiles",
        mechanicalStackPressureConstraint: "Continuous 0.5 to 5.0 MPa external isostatic/spring pressure to prevent interfacial voiding and micro-delamination during lithium stripping/plating",
        operationalTemperatureWindow: "-30°C to +75°C without requiring high-parasitic cell heaters",
      },
      manufacturingSupplyChainRealities: {
        dryRoomRequirements: "Sulfide electrolyte processing demands ultra-dry cleanrooms with atmospheric dew points below -50°C to -65°C, increasing cleanroom HVAC capex/opex by 35-45%",
        anodeIntegration: "Transition from graphite/silicon composite slurries to pure thin metallic lithium foil (< 20 µm) or in-situ anode-free current collector plating architecture",
        separatorManufacturing: "Roll-to-roll continuous defect-free ceramic/sulfide film deposition at web speeds > 15 meters/minute with zero pinholes",
        packLevelCostTrajectory: {
          year2025_PilotProduction: "$220 - $300 / kWh (restricted to low-volume luxury EVs, motorsport, and proof-of-concept prototypes)",
          year2027_InitialCommercialRamp: "$125 - $155 / kWh (premium consumer electric vehicle rollout, initial OEM options)",
          year2030_MassMarketParity: "< $75 - $80 / kWh (parity with conventional liquid LFP and advanced sodium-ion cells)",
        },
      },
      commercialRoadmapTimeline: [
        { phase: "2025 - Early 2026", milestone: "B-sample & C-sample cell engineering verification, specialized luxury vehicle debuts (Nio 150kWh semi-solid, MG Cyberster validation)" },
        { phase: "2026 - 2027", milestone: "Pilot line scaling by Tier-1 OEMs (Toyota-Idemitsu 2027 commercial line, Samsung SDI 2027 pilot, QuantumScape Cobra process ramp with PowerCo/VW)" },
        { phase: "2027 - 2028", milestone: "First commercial consumer series offerings in premium segments (> $60k MSRP vehicles); simultaneous coexistence with high-nickel and LFP architectures" },
      ],
    };
  },
});

// 2. Sub-Agent 1: In-depth Technical Researcher
const researcher = new SubAgent({
  name: "deep_researcher",
  description: "Conducts deep technical and market research on complex topics.",
  instructions:
    "You are an exhaustive research specialist. Investigate the topic thoroughly, " +
    "providing deep technical breakthroughs, quantifiable metrics, and positive growth indicators.",
  model: process.env.SUB_AGENT_MODEL,
  thinkingLevel: (process.env.THINKING_LEVEL as any) ?? "medium",
  cache: { retention: "short" },
});

// 3. Sub-Agent 2: Adversarial Critic
const critic = new SubAgent({
  name: "adversarial_critic",
  description: "Critiques research findings, challenges assumptions, and identifies hidden risks.",
  instructions:
    "You are a skeptical, rigorous devil's advocate. Stress-test research findings, " +
    "expose hidden economic bottlenecks, unverified assumptions, regulatory barriers, and potential failure points.",
  model: process.env.SUB_AGENT_MODEL,
  stateless: true, // One-shot evaluation mode: does not persist history across turns
  thinkingLevel: (process.env.THINKING_LEVEL as any) ?? "medium",
  cache: { retention: "short" },
});

// 4. Main Lead Agent
// Demonstrates clean separation: tools in `tools: { ... }` and subagents in `subagents: [ ... ]`
const lead = new Agent({
  name: "Editorial Lead",
  instructions:
    "You are an executive editorial director. Coordinate the research pipeline:\n" +
    "1. First call get_topic_brief to understand key themes.\n" +
    "2. Delegate deep-dive investigation to deep_researcher.\n" +
    "3. Pass those research findings to adversarial_critic for rigorous critique.\n" +
    "4. Synthesize both viewpoints into an objective, executive-level decision report with a comparison table.\n" +
    "In your final turn, output your complete executive report directly as your final response.",
  model: process.env.MODEL,
  // Clean separation of concerns:
  tools: { get_topic_brief },
  subagents: [researcher, critic],
    thinkingLevel: "high",
  cache: { retention: "short" },
});

// 5. Execution Pipeline with Streaming & Telemetry
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const formatCost = (c?: number) => (!c || c <= 0 ? "$0.00" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);

console.log("\n\x1b[36m━━━ Starting Research & Critique Multi-Agent Pipeline ━━━\x1b[0m\n");

const topic = "Commercial deployment of Solid-State Batteries in consumer EVs over the next 3 years";
console.log(`\x1b[32mTopic: ${topic}\x1b[0m\n`);

const response = await lead.run(topic, {
  stream: true,
  wrapThinking: true,
  onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
  onDelta: (d) => process.stdout.write(d),
  onEvent: (e) => {
    if (e.type === "subagent_complete") {
      const s = e.subagent!;
      console.log(`\n\x1b[33m↳ [SubAgent Completed] ${s.name} (${s.durationMs}ms • ${fmt(s.usage.totalTokens)} tok • ${formatCost(s.usage.cost?.totalCost)} • provider: ${s.provider} • model: ${s.model})\x1b[0m\n`);
    }
  },
}).catch(fail);

// 6. Summary Telemetry
const cached = response.usage.cachedTokens ?? response.usage.cacheReadTokens ?? 0;
const totalPrompt = Math.max(response.usage.inputTokens, cached);
const hitRate = totalPrompt > 0 ? ((cached / totalPrompt) * 100).toFixed(1) : "0.0";

let subagentsInput = 0;
let subagentsCached = 0;
for (const s of response.subagents || []) {
  subagentsInput += s.usage.inputTokens || 0;
  subagentsCached += s.usage.cachedTokens ?? s.usage.cacheReadTokens ?? 0;
}
const leadInput = Math.max(0, response.usage.inputTokens - subagentsInput);
const leadCached = Math.max(0, cached - subagentsCached);
const leadTotalPrompt = Math.max(leadInput, leadCached);
const leadHitRate = leadTotalPrompt > 0 ? ((leadCached / leadTotalPrompt) * 100).toFixed(1) : "0.0";

console.log("\n" + "═".repeat(70));
console.log(`\x1b[35mTotal Pipeline Runtime: ${response.durationMs}ms • Turns: ${response.turns}\x1b[0m`);
console.log(`\x1b[32mLead Agent Cache: ↑${fmt(leadInput)} in | CR: ${fmt(leadCached)} cached (${leadHitRate}% hit rate) | provider: ${response.provider} | model: ${response.model}\x1b[0m`);
console.log(`\x1b[35mTotal Pipeline Tokens:   ↑${fmt(response.usage.inputTokens)} in | ↓${fmt(response.usage.outputTokens)} out | CR: ${fmt(cached)} cached (${hitRate}% combined hit rate) | Total Cost: ${formatCost(response.usage.cost?.totalCost)}\x1b[0m`);

if (response.subagents && response.subagents.length > 0) {
  console.log("\n\x1b[1mSub-Agent Breakdown:\x1b[0m");
  for (const s of response.subagents) {
    const sCached = s.usage.cachedTokens ?? s.usage.cacheReadTokens ?? 0;
    const sTotalPrompt = Math.max(s.usage.inputTokens, sCached);
    const sHitRate = sTotalPrompt > 0 ? ((sCached / sTotalPrompt) * 100).toFixed(1) : "0.0";
    console.log(`  • ${s.name.padEnd(22)} | ${s.durationMs}ms | ${fmt(s.usage.totalTokens)} tok (CR: ${fmt(sCached)} [${sHitRate}%]) | ${formatCost(s.usage.cost?.totalCost)} | provider: ${s.provider} | model: ${s.model}`);
  }
}
console.log("═".repeat(70) + "\n");
