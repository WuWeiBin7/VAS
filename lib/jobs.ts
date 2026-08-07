import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getConfigPath } from "@/lib/model-config";
import type { ClassificationPlan, FrameResult, JobEvent, JobManifest } from "@/lib/types";
import { validateFolder } from "@/lib/folders";

type RuntimeJob = {
  manifest: JobManifest;
  process?: ChildProcessWithoutNullStreams;
  subscribers: Set<(event: JobEvent) => void>;
};

type JobStore = {
  loaded: boolean;
  jobs: Map<string, RuntimeJob>;
};

const globalStore = globalThis as typeof globalThis & { __vasJobStore?: JobStore };
const store = globalStore.__vasJobStore ?? { loaded: false, jobs: new Map<string, RuntimeJob>() };
globalStore.__vasJobStore = store;

const dataDir = path.join(process.cwd(), "server-data");
const registryPath = path.join(dataDir, "jobs.json");

export async function listJobs() {
  await loadJobs();
  await Promise.all([...store.jobs.values()].map((job) => refreshManifest(job)));
  return [...store.jobs.values()]
    .map((job) => job.manifest)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getJob(id: string) {
  await loadJobs();
  const job = store.jobs.get(id);
  if (!job) return null;
  await refreshManifest(job);
  return job.manifest;
}

export async function createJob(input: {
  inputDir: string;
  framesPerVideo: number;
  concurrency: number;
  plan: ClassificationPlan;
}) {
  await loadJobs();
  const active = [...store.jobs.values()].find((job) => job.manifest.status === "running" && job.process);
  if (active) throw new Error(`已有任务正在运行：${active.manifest.id}`);
  const inputDir = await validateFolder(input.inputDir);
  if (!Number.isInteger(input.framesPerVideo) || input.framesPerVideo < 1 || input.framesPerVideo > 120) {
    throw new Error("每个视频帧数必须是 1–120 的整数");
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 8) {
    throw new Error("并发数必须是 1–8 的整数");
  }
  validatePlan(input.plan);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const jobDir = path.join(inputDir, "_video_classification", `${stamp}-${id}`);
  await fsp.mkdir(jobDir, { recursive: true });
  const digest = hashPlan(input.plan);
  const now = new Date().toISOString();
  const manifest: JobManifest = {
    id,
    input_dir: inputDir,
    job_dir: jobDir,
    status: "running",
    frames_per_video: input.framesPerVideo,
    concurrency: input.concurrency,
    plan_hash: digest,
    created_at: now,
    updated_at: now,
    completed_videos: 0,
    completed_frames: 0,
    failed_frames: 0,
    video_results: [],
  };
  await writeJson(path.join(jobDir, "classification_plan.json"), input.plan);
  await writeJson(path.join(jobDir, "manifest.json"), manifest);
  const runtime: RuntimeJob = { manifest, subscribers: new Set() };
  store.jobs.set(id, runtime);
  await saveRegistry();
  spawnWorker(runtime);
  return manifest;
}

export async function resumeJob(id: string) {
  await loadJobs();
  const job = store.jobs.get(id);
  if (!job) throw new Error("任务不存在");
  await refreshManifest(job);
  if (job.process || job.manifest.status === "completed") {
    throw new Error(job.manifest.status === "completed" ? "任务已经完成" : "任务正在运行");
  }
  await fsp.rm(path.join(job.manifest.job_dir, "cancel.requested"), { force: true });
  job.manifest.status = "running";
  job.manifest.error = null;
  job.manifest.updated_at = new Date().toISOString();
  await writeJson(path.join(job.manifest.job_dir, "manifest.json"), job.manifest);
  await saveRegistry();
  spawnWorker(job);
  return job.manifest;
}

export async function cancelJob(id: string) {
  await loadJobs();
  const job = store.jobs.get(id);
  if (!job) throw new Error("任务不存在");
  if (!job.process) throw new Error("任务当前未运行");
  await fsp.writeFile(path.join(job.manifest.job_dir, "cancel.requested"), "cancel\n", "utf-8");
  publish(job, { type: "cancel_requested" });
  return { ok: true };
}

export async function subscribe(id: string, listener: (event: JobEvent) => void) {
  await loadJobs();
  const job = store.jobs.get(id);
  if (!job) return null;
  job.subscribers.add(listener);
  return () => job.subscribers.delete(listener);
}

export async function getFrameResults(id: string) {
  const manifest = await getJob(id);
  if (!manifest) return null;
  const file = path.join(manifest.job_dir, "frame_results.jsonl");
  try {
    const latest = new Map<string, FrameResult & { checkpoint_key: string }>();
    for (const line of (await fsp.readFile(file, "utf-8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as FrameResult & { checkpoint_key: string };
        latest.set(item.checkpoint_key, item);
      } catch {}
    }
    return [...latest.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path, "zh-CN") || a.sample_index - b.sample_index);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function resolveFramePath(id: string, relativePath: string) {
  const manifest = await getJob(id);
  if (!manifest) throw new Error("任务不存在");
  const resolved = path.resolve(manifest.job_dir, relativePath);
  const relation = path.relative(manifest.job_dir, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("无效的帧路径");
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error("帧文件不存在");
  return resolved;
}

async function loadJobs() {
  if (store.loaded) return;
  store.loaded = true;
  await fsp.mkdir(dataDir, { recursive: true });
  try {
    const entries = JSON.parse(await fsp.readFile(registryPath, "utf-8")) as Array<{ id: string; job_dir: string }>;
    for (const entry of entries) {
      try {
        const manifest = JSON.parse(await fsp.readFile(path.join(entry.job_dir, "manifest.json"), "utf-8")) as JobManifest;
        if (manifest.status === "running") {
          manifest.status = "interrupted";
          manifest.updated_at = new Date().toISOString();
          await writeJson(path.join(entry.job_dir, "manifest.json"), manifest);
        }
        store.jobs.set(manifest.id, { manifest, subscribers: new Set() });
      } catch {}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function spawnWorker(job: RuntimeJob) {
  const python = resolvePython();
  const child = spawn(/* turbopackIgnore: true */ python, ["-m", "video_classifier.worker", "--job-dir", job.manifest.job_dir, "--config", getConfigPath()], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  job.process = child;
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        publish(job, JSON.parse(line) as JobEvent);
      } catch {
        publish(job, { type: "worker_log", message: line });
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf-8").trim();
    if (message) publish(job, { type: "worker_stderr", error: message });
  });
  child.on("error", async (error) => {
    job.process = undefined;
    job.manifest.status = "failed";
    job.manifest.error = error.message;
    await writeJson(path.join(job.manifest.job_dir, "manifest.json"), job.manifest);
    publish(job, { type: "job_error", error: error.message });
  });
  child.on("exit", async (code) => {
    job.process = undefined;
    await refreshManifest(job);
    if (job.manifest.status === "running") {
      job.manifest.status = code === 0 ? "completed" : code === 2 ? "cancelled" : "failed";
      job.manifest.updated_at = new Date().toISOString();
      await writeJson(path.join(job.manifest.job_dir, "manifest.json"), job.manifest);
    }
    await saveRegistry();
    publish(job, { type: "process_exit", status: job.manifest.status, code });
  });
}

async function refreshManifest(job: RuntimeJob) {
  try {
    job.manifest = JSON.parse(await fsp.readFile(path.join(job.manifest.job_dir, "manifest.json"), "utf-8")) as JobManifest;
  } catch {}
}

function publish(job: RuntimeJob, event: JobEvent) {
  for (const subscriber of job.subscribers) subscriber(event);
}

async function saveRegistry() {
  await fsp.mkdir(dataDir, { recursive: true });
  await writeJson(registryPath, [...store.jobs.values()].map((job) => ({ id: job.manifest.id, job_dir: job.manifest.job_dir })));
}

async function writeJson(file: string, payload: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(payload, null, 2), "utf-8");
  await fsp.rename(temporary, file);
}

function resolvePython() {
  const candidates = [
    path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
    path.join(process.cwd(), ".venv", "bin", "python"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? (process.platform === "win32" ? "python" : "python3");
}

function validatePlan(plan: ClassificationPlan) {
  if (!plan?.task_description?.trim() || !plan.frame_prompt?.trim() || !Array.isArray(plan.labels) || plan.labels.length < 2) {
    throw new Error("分类方案不完整");
  }
  const ids = plan.labels.map((label) => label.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-z0-9][a-z0-9_-]*$/.test(id))) {
    throw new Error("类别 ID 必须唯一，并且只能包含小写字母、数字、下划线或连字符");
  }
}

function hashPlan(plan: ClassificationPlan) {
  return crypto.createHash("sha256").update(JSON.stringify(sortObject(plan))).digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortObject(child)]));
  }
  return value;
}
