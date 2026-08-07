import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveFramePath } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const relativePath = new URL(request.url).searchParams.get("path");
    if (!relativePath) throw new Error("path 不能为空");
    const file = await resolveFramePath((await context.params).id, relativePath);
    return new Response(await fsp.readFile(file), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "帧读取失败" }, { status: 404 });
  }
}

