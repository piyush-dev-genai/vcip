import type { ReactNode } from 'react';
import './globals.css';

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
