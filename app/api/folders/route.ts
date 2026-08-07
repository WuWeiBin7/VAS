import { NextResponse } from "next/server";

import { browseFolders, scanVideos, validateFolder } from "@/lib/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const path = new URL(request.url).searchParams.get("path") ?? undefined;
    return NextResponse.json(await browseFolders(path));
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { path?: string; action?: "validate" | "scan" };
    if (!body.path) throw new Error("path 不能为空");
    if (body.action === "scan") return NextResponse.json(await scanVideos(body.path));
    return NextResponse.json({ path: await validateFolder(body.path), valid: true });
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 400 });
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "文件夹操作失败";
}

