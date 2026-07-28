export const metadata = {
  title: "MLB 今日賽事勝率預測",
  description: "結合球季戰績、得失分差、先發投手 ERA、近況與傷兵名單的 MLB 賽事勝率預測看板",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
