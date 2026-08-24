import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://tsuki-anime-rebuild.op311i5lxa.chatgpt.site"),
  title: "月下集",
  description: "把喜欢的作品，都收进月光里。动画、游戏、书籍、漫画与音乐的个人收藏中心。",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon-32.png",
    apple: "/apple-touch-icon.png",
  },
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
  return <html lang="zh-CN"><body>{children}</body></html>;
}
