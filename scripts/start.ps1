$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
  throw "尚未安装运行环境，请先执行 scripts\setup.ps1"
}
if (-not (Test-Path -LiteralPath "node_modules")) {
  throw "尚未安装前端依赖，请先执行 scripts\setup.ps1"
}

npm run dev

