import fs from "node:fs/promises";
import path from "node:path";

export type ModelConfigInput = {
  provider: string;
  base_url: string;
  api_key?: string;
  research_model: string;
  vision_model: string;
};

const configPath = path.join(process.cwd(), "config.json");

export async function readModelConfigSummary() {
  const config = await readConfig();
  const envKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
  return {
    provider: text(config.provider) ?? process.env.VAS_PROVIDER ?? "dashscope",
    base_url: text(config.base_url) ?? process.env.VAS_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    research_model: text(config.research_model) ?? process.env.VAS_RESEARCH_MODEL ?? "qwen-plus",
    vision_model: text(config.vision_model) ?? process.env.VAS_VISION_MODEL ?? "qwen-vl-plus",
    api_key_configured: Boolean(text(config.api_key) || envKey),
  };
}

export async function saveModelConfig(input: ModelConfigInput) {
  if (!input.base_url?.trim() || !input.research_model?.trim() || !input.vision_model?.trim()) {
    throw new Error("Base URL、研究模型和视觉模型不能为空");
  }
  let current = await readConfig();
  current = {
    ...current,
    provider: input.provider?.trim().toLowerCase() || "dashscope",
    base_url: input.base_url.trim().replace(/\/$/, ""),
    research_model: input.research_model.trim(),
    vision_model: input.vision_model.trim(),
  };
  if (input.api_key?.trim()) current.api_key = input.api_key.trim();
  await fs.writeFile(configPath, JSON.stringify(current, null, 2), { encoding: "utf-8", mode: 0o600 });
  return readModelConfigSummary();
}

export function getConfigPath() {
  return configPath;
}

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const payload = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

