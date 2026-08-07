"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CategoryLabel, ClassificationPlan, FrameResult, JobManifest } from "@/lib/types";

type ConfigSummary = {
  provider: string;
  base_url: string;
  research_model: string;
  vision_model: string;
  api_key_configured: boolean;
};

type ScanResult = {
  inputDir: string;
  count: number;
  totalBytes: number;
  videos: Array<{ relativePath: string; size: number }>;
};

const blankConfig: ConfigSummary = {
  provider: "dashscope",
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  research_model: "qwen-plus",
  vision_model: "qwen-vl-plus",
  api_key_configured: false,
};

export function Workspace() {
  const [config, setConfig] = useState<ConfigSummary>(blankConfig);
  const [apiKey, setApiKey] = useState("");
  const [inputDir, setInputDir] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [framesPerVideo, setFramesPerVideo] = useState(8);
  const [concurrency, setConcurrency] = useState(2);
  const [task, setTask] = useState("区分视频为第一人称视角还是第三人称视角");
  const [plan, setPlan] = useState<ClassificationPlan | null>(null);
  const [jobs, setJobs] = useState<JobManifest[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobManifest | null>(null);
  const [frameResults, setFrameResults] = useState<FrameResult[]>([]);
  const [folderOpen, setFolderOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const request = useCallback(async <T,>(url: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(url, options);
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
    return payload;
  }, []);

  const refreshJobs = useCallback(async () => {
    const payload = await request<{ jobs: JobManifest[] }>("/api/jobs", { cache: "no-store" });
    setJobs(payload.jobs);
    if (!selectedJobId && payload.jobs.length) setSelectedJobId(payload.jobs[0].id);
  }, [request, selectedJobId]);

  const refreshSelected = useCallback(async () => {
    if (!selectedJobId) return;
    const payload = await request<{ job: JobManifest; frames: FrameResult[] }>(`/api/jobs/${selectedJobId}`, { cache: "no-store" });
    setSelectedJob(payload.job);
    setFrameResults(payload.frames);
  }, [request, selectedJobId]);

  useEffect(() => {
    void request<ConfigSummary>("/api/config", { cache: "no-store" }).then(setConfig).catch(showError);
    // Initial network hydration; state is updated only after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshJobs().catch(showError);
  }, [request, refreshJobs]);

  useEffect(() => {
    if (!selectedJobId) return;
    // Hydrate the selected task after the identifier changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSelected().catch(showError);
    const source = new EventSource(`/api/jobs/${selectedJobId}/events`);
    source.onmessage = () => void refreshSelected();
    source.onerror = () => source.close();
    const timer = window.setInterval(() => void refreshSelected(), 2500);
    return () => {
      source.close();
      window.clearInterval(timer);
    };
  }, [selectedJobId, refreshSelected]);

  function showError(error: unknown) {
    setNotice({ kind: "error", text: error instanceof Error ? error.message : "发生未知错误" });
  }

  async function saveConfig() {
    setBusy("config");
    try {
      const updated = await request<ConfigSummary>("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, api_key: apiKey }),
      });
      setConfig(updated);
      setApiKey("");
      setNotice({ kind: "success", text: "模型设置已安全保存到本机。" });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }

  async function scanFolder(path = inputDir) {
    if (!path) return showError(new Error("请先选择视频文件夹"));
    setBusy("scan");
    try {
      const result = await request<ScanResult>("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, action: "scan" }),
      });
      setInputDir(result.inputDir);
      setScan(result);
      setPlan(null);
      setNotice({ kind: "success", text: `已找到 ${result.count} 个可处理视频。` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }

  async function researchPlan() {
    if (!config.api_key_configured) return showError(new Error("请先保存 API Key"));
    if (!scan?.count) return showError(new Error("请先扫描包含视频的文件夹"));
    setBusy("research");
    try {
      const payload = await request<{ plan: ClassificationPlan }>("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      setPlan(payload.plan);
      setNotice({ kind: "success", text: "分类方案已生成，请检查并确认后开始。" });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }

  async function startJob() {
    if (!plan || !scan) return;
    setBusy("start");
    try {
      const payload = await request<{ job: JobManifest }>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputDir: scan.inputDir, framesPerVideo, concurrency, plan }),
      });
      setSelectedJobId(payload.job.id);
      setSelectedJob(payload.job);
      setPlan(null);
      await refreshJobs();
      setNotice({ kind: "success", text: `任务 ${payload.job.id} 已开始。` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }

  async function jobAction(action: "cancel" | "resume") {
    if (!selectedJobId) return;
    setBusy(action);
    try {
      await request(`/api/jobs/${selectedJobId}/${action}`, { method: "POST" });
      await refreshSelected();
      await refreshJobs();
    } catch (error) { showError(error); } finally { setBusy(null); }
  }

  const progress = selectedJob?.total_videos
    ? Math.round(((selectedJob.completed_videos ?? 0) / selectedJob.total_videos) * 100)
    : 0;
  const selectedFrames = useMemo(() => {
    const ids = new Set(selectedJob?.video_results?.map((item) => item.video_id) ?? []);
    return frameResults.filter((item) => ids.has(item.video_id));
  }, [frameResults, selectedJob]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">VS</span><div><strong>VideoSort</strong><small>本地视频分类工作台</small></div></div>
        <div className="local-badge"><span />仅在本机运行 · 127.0.0.1</div>
      </header>

      {notice && <div className={`notice ${notice.kind}`}><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div>}

      <section className="hero">
        <div><p className="eyebrow">VISION CLASSIFICATION PIPELINE</p><h1>从视频文件夹到<br/><em>可追溯的分类结果</em></h1></div>
        <p className="hero-copy">平均抽帧、提示词调研、视觉模型判定与多数投票，一条本地流水线完成。原始视频始终留在你的电脑上。</p>
      </section>

      <div className="workspace-grid">
        <div className="setup-column">
          <Section number="01" title="模型设置" subtitle="DashScope · OpenAI 兼容接口" status={config.api_key_configured ? "已配置" : "待配置"}>
            <div className="form-grid two">
              <Field label="接口类型"><select value={config.provider} onChange={(e) => setConfig({ ...config, provider: e.target.value })}><option value="dashscope">DashScope（启用联网搜索）</option></select></Field>
              <Field label="API Key"><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config.api_key_configured ? "已配置；留空保持不变" : "sk-..."} /></Field>
            </div>
            <Field label="Base URL"><input value={config.base_url} onChange={(e) => setConfig({ ...config, base_url: e.target.value })} /></Field>
            <div className="form-grid two">
              <Field label="调研模型"><input value={config.research_model} onChange={(e) => setConfig({ ...config, research_model: e.target.value })} /></Field>
              <Field label="视觉模型"><input value={config.vision_model} onChange={(e) => setConfig({ ...config, vision_model: e.target.value })} /></Field>
            </div>
            <div className="actions end"><button className="button secondary" onClick={saveConfig} disabled={busy === "config"}>{busy === "config" ? "保存中…" : "保存模型设置"}</button></div>
          </Section>

          <Section number="02" title="选择视频" subtitle="递归扫描所有子文件夹" status={scan ? `${scan.count} 个视频` : "未扫描"}>
            <label className="folder-field"><span>{inputDir || "选择本机视频文件夹"}</span><button onClick={() => setFolderOpen(true)}>浏览</button></label>
            {scan && <div className="scan-summary"><div><strong>{scan.count}</strong><span>视频文件</span></div><div><strong>{formatBytes(scan.totalBytes)}</strong><span>素材体积</span></div><div><strong>{scan.videos.length ? formatBytes(Math.round(scan.totalBytes / scan.videos.length)) : "—"}</strong><span>平均大小</span></div></div>}
            <div className="actions end"><button className="button ghost" onClick={() => void scanFolder()} disabled={!inputDir || busy === "scan"}>{busy === "scan" ? "扫描中…" : "重新扫描"}</button></div>
          </Section>

          <Section number="03" title="配置任务" subtitle="平均取帧 · 中心点采样">
            <div className="form-grid two">
              <Field label="每个视频分析帧数"><input type="number" min={1} max={120} value={framesPerVideo} onChange={(e) => setFramesPerVideo(clamp(Number(e.target.value), 1, 120))} /></Field>
              <Field label="模型并发请求"><input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(clamp(Number(e.target.value), 1, 8))} /></Field>
            </div>
            <Field label="分类任务描述"><textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="例如：区分视频为第一人称视角还是第三人称视角" /></Field>
            <div className="estimate"><span>预计视觉请求</span><strong>{scan ? scan.count * framesPerVideo : 0} 次</strong><small>实际数量可能因损坏或过短视频略有减少</small></div>
            <div className="actions end"><button className="button primary" onClick={researchPlan} disabled={!scan?.count || busy === "research"}>{busy === "research" ? <><Spinner/>联网调研中…</> : "生成分类方案"}</button></div>
          </Section>

          {plan && <PlanEditor plan={plan} onChange={setPlan} onStart={startJob} busy={busy === "start"} />}
        </div>

        <aside className="results-column">
          <section className="result-panel sticky">
            <div className="panel-heading"><div><p className="eyebrow">LIVE RUN</p><h2>任务与结果</h2></div><button className="icon-button" onClick={() => void refreshJobs()} aria-label="刷新">↻</button></div>
            {jobs.length > 0 && <select className="job-select" value={selectedJobId ?? ""} onChange={(e) => setSelectedJobId(e.target.value)}>{jobs.map((job) => <option key={job.id} value={job.id}>{job.id} · {statusText(job.status)} · {new Date(job.created_at).toLocaleString("zh-CN")}</option>)}</select>}
            {!selectedJob ? <EmptyState /> : <>
              <div className="run-status"><div className={`status-orb ${selectedJob.status}`}><span /></div><div><strong>{statusText(selectedJob.status)}</strong><small>{selectedJob.current_video || `任务 ${selectedJob.id}`}</small></div><b>{progress}%</b></div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              <div className="metrics"><Metric value={`${selectedJob.completed_videos ?? 0}/${selectedJob.total_videos ?? "—"}`} label="已完成视频"/><Metric value={selectedJob.completed_frames ?? 0} label="已分析帧"/><Metric value={selectedJob.failed_frames ?? 0} label="失败帧"/></div>
              {selectedJob.error && <p className="inline-error">{selectedJob.error}</p>}
              <div className="job-actions">
                {selectedJob.status === "running" && <button className="button danger" onClick={() => void jobAction("cancel")} disabled={busy === "cancel"}>安全取消</button>}
                {["cancelled", "failed", "interrupted"].includes(selectedJob.status) && <button className="button primary" onClick={() => void jobAction("resume")} disabled={busy === "resume"}>从断点继续</button>}
                <button className="button ghost" title={selectedJob.job_dir} onClick={() => void navigator.clipboard.writeText(selectedJob.job_dir).then(() => setNotice({ kind: "success", text: "结果目录路径已复制。" })).catch(showError)}>复制结果路径</button>
              </div>
              <VideoResults job={selectedJob} />
              <FrameGallery jobId={selectedJob.id} frames={selectedFrames} />
            </>}
          </section>
        </aside>
      </div>
      {folderOpen && <FolderPicker startPath={inputDir} onClose={() => setFolderOpen(false)} onSelect={(path) => { setFolderOpen(false); setInputDir(path); void scanFolder(path); }} request={request} />}
    </main>
  );
}

function Section({ number, title, subtitle, status, children }: { number: string; title: string; subtitle: string; status?: string; children: React.ReactNode }) {
  return <section className="step-card"><header><span className="step-number">{number}</span><div><h2>{title}</h2><p>{subtitle}</p></div>{status && <b className="step-status">{status}</b>}</header><div className="step-body">{children}</div></section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Metric({ value, label }: { value: React.ReactNode; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function Spinner() { return <span className="spinner" />; }

function PlanEditor({ plan, onChange, onStart, busy }: { plan: ClassificationPlan; onChange: (plan: ClassificationPlan) => void; onStart: () => void; busy: boolean }) {
  function updateLabel(index: number, patch: Partial<CategoryLabel>) { onChange({ ...plan, labels: plan.labels.map((item, i) => i === index ? { ...item, ...patch } : item) }); }
  return <Section number="04" title="确认分类方案" subtitle="联网调研结果 · 开始前可编辑" status="待确认">
    <div className="research-note"><strong>调研摘要</strong><textarea rows={3} value={plan.research_summary} onChange={(e) => onChange({ ...plan, research_summary: e.target.value })}/></div>
    <div className="label-list">{plan.labels.map((label, index) => <div className="label-editor" key={`${label.id}-${index}`}>
      <div className="label-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="label-fields">
        <div className="form-grid label-row"><Field label="类别 ID"><input value={label.id} onChange={(e) => updateLabel(index, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}/></Field><Field label="显示名称"><input value={label.name} onChange={(e) => updateLabel(index, { name: e.target.value })}/></Field></div>
        <Field label="判定定义"><textarea rows={2} value={label.definition} onChange={(e) => updateLabel(index, { definition: e.target.value })}/></Field>
        <Field label="正向视觉线索（每行一条）"><textarea rows={2} value={label.positive_cues.join("\n")} onChange={(e) => updateLabel(index, { positive_cues: lines(e.target.value) })}/></Field>
        <Field label="排除线索（每行一条）"><textarea rows={2} value={label.negative_cues.join("\n")} onChange={(e) => updateLabel(index, { negative_cues: lines(e.target.value) })}/></Field>
      </div>
    </div>)}</div>
    <Field label="全局规则（每行一条）"><textarea rows={3} value={plan.global_rules.join("\n")} onChange={(e) => onChange({ ...plan, global_rules: lines(e.target.value) })}/></Field>
    <Field label="逐帧提示词"><textarea rows={5} value={plan.frame_prompt} onChange={(e) => onChange({ ...plan, frame_prompt: e.target.value })}/></Field>
    <div className="confirm-box"><span>✓</span><p><strong>开始即视为确认此方案</strong><small>方案会写入任务目录并计算哈希；后续修改将创建新任务。</small></p><button className="button primary" onClick={onStart} disabled={busy}>{busy ? "启动中…" : "确认并开始分类"}</button></div>
  </Section>;
}

function VideoResults({ job }: { job: JobManifest }) {
  const results = [...(job.video_results ?? [])].reverse();
  if (!results.length) return null;
  return <div className="result-block"><div className="block-title"><h3>视频分类</h3><span>{results.length} 条</span></div><div className="video-table">{results.map((item) => <div className="video-row" key={item.video_id}><div className="file-icon">▶</div><div className="video-name"><strong title={item.relative_path}>{item.relative_path}</strong><small>{item.completed_frames} 成功 · {item.failed_frames} 失败</small></div><div className={`label-pill ${item.label_id === "uncertain" ? "uncertain" : ""}`}>{item.label_id === "uncertain" ? "不确定" : item.label_id}</div><div className="votes" title={`完整票数：${JSON.stringify(item.vote_counts)}`}>{validVoteCount(item.vote_counts)} 有效票</div></div>)}</div></div>;
}

function FrameGallery({ jobId, frames }: { jobId: string; frames: FrameResult[] }) {
  const latest = frames.slice(-12).reverse();
  if (!latest.length) return null;
  return <div className="result-block"><div className="block-title"><h3>最近分析帧</h3><span>显示 {latest.length}/{frames.length}</span></div><div className="frame-grid">{latest.map((frame) => <article key={`${frame.video_id}-${frame.sample_index}`} className="frame-card">
    <div className="frame-image">{frame.frame_path ? <div className="frame-preview" role="img" aria-label={`${frame.relative_path} 第 ${frame.sample_index + 1} 帧`} style={{ backgroundImage: `url("/api/jobs/${jobId}/frame?path=${encodeURIComponent(frame.frame_path)}")` }}/> : <span>无法预览</span>}<b>{formatTime(frame.actual_timestamp_ms ?? frame.target_timestamp_ms)}</b></div>
    <div><strong>{frame.status === "success" ? frame.label_id : "失败"}</strong><span>{frame.confidence != null ? `${Math.round(frame.confidence * 100)}%` : "—"}</span><p title={frame.reason || frame.error}>{frame.reason || frame.error}</p></div>
  </article>)}</div></div>;
}

function EmptyState() { return <div className="empty-state"><div className="empty-rings"><span/><span/><b>▶</b></div><h3>等待第一个任务</h3><p>完成左侧设置并确认分类方案后，实时进度与结果会显示在这里。</p></div>; }

function FolderPicker({ startPath, onClose, onSelect, request }: { startPath: string; onClose: () => void; onSelect: (path: string) => void; request: <T>(url: string, options?: RequestInit) => Promise<T> }) {
  type Browse = { roots: Array<{ name: string; path: string }>; currentPath: string | null; parentPath: string | null; directories: Array<{ name: string; path: string }> };
  const [data, setData] = useState<Browse | null>(null);
  const [manual, setManual] = useState(startPath);
  const [error, setError] = useState("");
  const load = useCallback(async (path?: string) => { try { setError(""); setData(await request<Browse>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`, { cache: "no-store" })); } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); } }, [request]);
  useEffect(() => {
    // Load the server-side directory listing after the modal mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(startPath || undefined);
  }, [load, startPath]);
  const entries = data?.currentPath ? data.directories : data?.roots ?? [];
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="folder-modal" role="dialog" aria-modal="true" aria-label="选择视频文件夹">
    <header><div><p className="eyebrow">LOCAL FOLDER</p><h2>选择视频文件夹</h2></div><button onClick={onClose} aria-label="关闭">×</button></header>
    <div className="manual-path"><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="也可以输入完整路径"/><button onClick={() => void load(manual)}>前往</button></div>
    <div className="folder-toolbar"><button onClick={() => void load(data?.parentPath ?? undefined)} disabled={!data?.parentPath}>← 上一级</button><span title={data?.currentPath ?? "选择磁盘"}>{data?.currentPath ?? "选择磁盘"}</span><button onClick={() => void load(data?.currentPath ?? undefined)}>↻</button></div>
    {error && <p className="inline-error">{error}</p>}
    <div className="folder-list">{entries.map((entry) => <button key={entry.path} onDoubleClick={() => void load(entry.path)} onClick={() => setManual(entry.path)} className={manual === entry.path ? "selected" : ""}><span>▰</span><div><strong>{entry.name}</strong><small>{entry.path}</small></div><b>›</b></button>)}{!entries.length && <p>此处没有子文件夹</p>}</div>
    <footer><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={!manual} onClick={() => onSelect(manual)}>选择此文件夹</button></footer>
  </section></div>;
}

function statusText(status: JobManifest["status"]) { return ({ draft: "草稿", researching: "调研中", awaiting_confirmation: "待确认", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" } as const)[status] ?? status; }
function formatBytes(bytes: number) { if (!Number.isFinite(bytes)) return "—"; const units = ["B", "KB", "MB", "GB", "TB"]; let value = bytes; let i = 0; while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; } return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`; }
function formatTime(ms?: number) { if (ms == null) return "—"; const total = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function clamp(value: number, min: number, max: number) { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min; }
function lines(value: string) { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function validVoteCount(counts: Record<string, number>) { return Object.entries(counts).reduce((sum, [label, count]) => sum + (label === "uncertain" ? 0 : count), 0); }
