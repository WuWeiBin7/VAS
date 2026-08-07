import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json(await cancelJob((await context.params).id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "取消失败" }, { status: 400 });
  }
}

