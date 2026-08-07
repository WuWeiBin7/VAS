import { NextResponse } from "next/server";

import { readModelConfigSummary, saveModelConfig } from "@/lib/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readModelConfigSummary());
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await saveModelConfig(body));
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 400 });
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "模型配置操作失败";
}

