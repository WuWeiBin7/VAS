$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
  python -m venv .venv
}

& ".venv\Scripts\python.exe" -m pip install --upgrade pip
& ".venv\Scripts\python.exe" -m pip install -e ".[test]"
npm install

Write-Host "环境准备完成。请复制 config_example.json 为 config.json，或直接在页面中填写模型设置。" -ForegroundColor Green

