import type { ReactNode } from 'react';

export const metadata = {
  title: 'V-CIP Verification',
  description: 'V-CIP MVP',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
