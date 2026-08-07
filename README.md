# VideoSort 本地视频分类工作台

VideoSort 会递归扫描本机文件夹中的视频，按等长区间中心点平均抽帧，将图像等比例缩放至最长边不超过 640 像素，使用 DashScope OpenAI 兼容视觉模型逐帧分类，再通过多数票生成视频级类别。原始视频不会被上传或修改；只有抽取的 JPEG 帧会发送给配置的大模型接口。

## 功能

- 浏览服务所在电脑的文件夹并递归扫描常见视频格式。
- 使用支持 `enable_search` 的 DashScope 研究模型生成分类类别、视觉线索和逐帧提示词。
- 在开始任务前人工编辑并确认分类方案。
- 每视频 1–120 帧、1–8 路视觉请求并发。
- 实时进度、逐视频投票和逐帧缩略图；`uncertain` 帧保留统计但不参与类别胜负计算。
- 每帧增量落盘，任务取消、失败或服务重启后可继续。
- 输出 JSONL、JSON 和带 UTF-8 BOM 的 CSV，方便 Excel 直接打开。

## 环境要求

- Windows 10/11
- Python 3.11 或更新版本
- Node.js 20 或更新版本

系统使用 PyAV 自带的 FFmpeg 解码库，不要求系统安装 `ffmpeg`。

## 安装和启动

在 PowerShell 中运行：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

然后访问终端显示的 `http://127.0.0.1:3000`。服务只监听本机回环地址。

首次使用时在页面“模型设置”中填写 API Key、Base URL、调研模型和视觉模型。API Key 保存在本机 `config.json`，该文件已加入 `.gitignore`；也可以通过 `DASHSCOPE_API_KEY` 等环境变量提供。

## 结果目录

每个任务保存在所选素材目录：

```text
_video_classification/<时间-任务ID>/
├── classification_plan.json
├── manifest.json
├── summary.json
├── frame_results.jsonl
├── frames.csv
├── videos.csv
└── frames/<视频ID>/*.jpg
```

`frame_results.jsonl` 是断点恢复的事实来源。修改输入视频、抽帧数或分类方案后，应创建新任务；系统不会把旧检查点误用于变化后的任务。

## 配置

配置文件字段参考 [config_example.json](./config_example.json)。环境变量优先级低于页面保存的非空配置：

- `DASHSCOPE_API_KEY` 或 `OPENAI_API_KEY`
- `VAS_PROVIDER`
- `VAS_BASE_URL`
- `VAS_RESEARCH_MODEL`
- `VAS_VISION_MODEL`
- `VIDEO_ALLOWED_ROOTS`：用分号、逗号或换行分隔允许浏览的根目录

## 测试与构建

```powershell
.venv\Scripts\python.exe -m pytest --basetemp .pytest-tmp
npm run build
```

## 安全边界

这是单用户本地工具，不包含身份认证，不应把端口代理到局域网或公网。帧预览接口只允许读取已登记任务目录内的文件；目录浏览可通过 `VIDEO_ALLOWED_ROOTS` 进一步收窄。
