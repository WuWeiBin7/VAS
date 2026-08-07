import { NextResponse } from "next/server";
import { resumeJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ job: await resumeJob((await context.params).id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "恢复失败" }, { status: 400 });
  }
}

