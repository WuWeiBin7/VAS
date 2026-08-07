import { NextResponse } from "next/server";

import { createJob, listJobs } from "@/lib/jobs";
import type { ClassificationPlan } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ jobs: await listJobs() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { inputDir?: string; framesPerVideo?: number; concurrency?: number; plan?: ClassificationPlan };
    if (!body.inputDir || !body.plan) throw new Error("输入文件夹和分类方案不能为空");
    const job = await createJob({
      inputDir: body.inputDir,
      framesPerVideo: Number(body.framesPerVideo ?? 8),
      concurrency: Number(body.concurrency ?? 2),
      plan: body.plan,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "任务创建失败" }, { status: 400 });
  }
}

