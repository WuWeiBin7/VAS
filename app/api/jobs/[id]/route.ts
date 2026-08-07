import { NextResponse } from "next/server";

import { getFrameResults, getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ job, frames: await getFrameResults(id) });
}

