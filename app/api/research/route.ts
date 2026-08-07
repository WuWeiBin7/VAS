import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import { getConfigPath } from "@/lib/model-config";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { task?: string };
    if (!body.task?.trim() || body.task.trim().length < 3) throw new Error("请填写完整的分类任务描述");
    const result = await runResearch(body.task.trim());
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分类方案调研失败" }, { status: 400 });
  }
}

function runResearch(task: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const python = resolvePython();
    const child = spawn(/* turbopackIgnore: true */ python, ["-m", "video_classifier.research_cli", "--task", task, "--config", getConfigPath()], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      try {
        const payload = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> & { error?: string };
        if (code !== 0 || payload.ok !== true) reject(new Error(payload.error || stderr.trim() || `研究进程退出：${code}`));
        else resolve(payload);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("研究进程返回了无效结果"));
      }
    });
  });
}

function resolvePython() {
  const candidates = [path.join(process.cwd(), ".venv", "Scripts", "python.exe"), path.join(process.cwd(), ".venv", "bin", "python")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? (process.platform === "win32" ? "python" : "python3");
}
