import fs from "node:fs/promises";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg"]);

export async function browseFolders(target?: string) {
  const roots = await availableRoots();
  if (!target) return { roots, currentPath: null, parentPath: null, directories: [] };
  const resolved = await validateFolder(target);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const parsed = path.parse(resolved);
  return {
    roots,
    currentPath: resolved,
    parentPath: resolved === parsed.root ? null : path.dirname(resolved),
    directories,
  };
}

export async function validateFolder(target: string) {
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("所选路径不是文件夹");
  const roots = await allowedRoots();
  if (roots.length && !roots.some((root) => isWithin(resolved, root))) {
    throw new Error("文件夹不在 VIDEO_ALLOWED_ROOTS 允许范围内");
  }
  return resolved;
}

export async function scanVideos(target: string) {
  const root = await validateFolder(target);
  const videos: Array<{ relativePath: string; path: string; size: number; mtimeMs: number }> = [];
  async function walk(directory: string) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === "_video_classification") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        let stat;
        try { stat = await fs.stat(fullPath); } catch { continue; }
        videos.push({
          relativePath: path.relative(root, fullPath).split(path.sep).join("/"),
          path: fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-CN"));
  return { inputDir: root, count: videos.length, totalBytes: videos.reduce((sum, item) => sum + item.size, 0), videos };
}

async function availableRoots() {
  const configured = await allowedRoots();
  if (configured.length) return configured.map((root) => ({ name: root, path: root }));
  if (process.platform === "win32") {
    const roots: Array<{ name: string; path: string }> = [];
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if ((await fs.stat(drive)).isDirectory()) roots.push({ name: drive, path: drive });
      } catch {}
    }
    return roots;
  }
  return [{ name: "/", path: "/" }];
}

async function allowedRoots() {
  const value = process.env.VIDEO_ALLOWED_ROOTS;
  if (!value?.trim()) return [];
  const resolved: string[] = [];
  for (const item of value.split(/[;\r\n,]+/).map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const root = path.resolve(item);
      if ((await fs.stat(root)).isDirectory()) resolved.push(root);
    } catch {}
  }
  return resolved;
}

function isWithin(target: string, root: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
