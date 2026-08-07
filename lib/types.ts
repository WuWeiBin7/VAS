export type CategoryLabel = {
  id: string;
  name: string;
  definition: string;
  positive_cues: string[];
  negative_cues: string[];
};

export type ClassificationPlan = {
  task_description: string;
  research_summary: string;
  labels: CategoryLabel[];
  global_rules: string[];
  frame_prompt: string;
};

export type FrameResult = {
  video_id: string;
  relative_path: string;
  sample_index: number;
  target_timestamp_ms: number;
  actual_timestamp_ms?: number;
  frame_path?: string;
  status: "success" | "failed";
  label_id?: string;
  confidence?: number;
  reason?: string;
  error?: string;
};

export type VideoResult = {
  video_id: string;
  relative_path: string;
  duration_ms?: number;
  status: string;
  label_id: string;
  vote_counts: Record<string, number>;
  completed_frames: number;
  failed_frames: number;
  error?: string | null;
};

export type JobManifest = {
  id: string;
  input_dir: string;
  job_dir: string;
  status: "draft" | "researching" | "awaiting_confirmation" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  frames_per_video: number;
  concurrency: number;
  plan_hash: string;
  created_at: string;
  updated_at: string;
  current_video?: string | null;
  total_videos?: number;
  completed_videos?: number;
  completed_frames?: number;
  failed_frames?: number;
  error?: string | null;
  video_results?: VideoResult[];
};

export type JobEvent = {
  type: string;
  result?: FrameResult | VideoResult;
  error?: string;
  summary?: unknown;
  [key: string]: unknown;
};

