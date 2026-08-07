import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VideoSort · 视频分类工作台",
  description: "本地视频抽帧与视觉大模型分类工具",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

