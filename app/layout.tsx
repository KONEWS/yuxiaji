import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://tsuki-anime-rebuild.op311i5lxa.chatgpt.site"),
  title: "月下集",
  description: "把喜欢的作品，都收进月光里。动画、游戏、书籍、漫画与音乐的个人收藏中心。",
  openGraph: {
    title: "月下集",
    description: "把喜欢的作品，都收进月光里。",
    type: "website",
    images: [{ url: "/og.png", width: 1672, height: 941, alt: "月下集" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "月下集",
    description: "把喜欢的作品，都收进月光里。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><head>
    <link rel="shortcut icon" href="/favicon-32.png?v=2" />
    <link rel="icon" href="/favicon-32.png?v=2" sizes="32x32" type="image/png" />
    <link rel="icon" href="/favicon-192.png?v=2" sizes="192x192" type="image/png" />
    <link rel="icon" href="/favicon.png?v=2" sizes="512x512" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
  </head><body>{children}</body></html>;
}
